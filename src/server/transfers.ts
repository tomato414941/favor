import { randomUUID } from 'node:crypto';
import { recipientEntitlement, type TransferState } from '../shared.js';
import {
  TransferRejected,
  type ConnectProvider,
  type Transfer,
  type TransferOperation,
} from './connect-provider.js';
import { Payments } from './payments.js';
import type { Store } from './store.js';

type Row = Omit<Transfer, 'operation_id'> & { net_amount: number; state: TransferState };

/** Keeps the recipient's net transfer in step with confirmed refunds and dispute outcomes. */
export class Transfers {
  private readonly operations = new Map<string, Promise<void>>();
  constructor(
    readonly store: Store,
    readonly provider: ConnectProvider,
    readonly payments: Payments,
    readonly clock = Date.now,
  ) {}

  async settle(requestId: string) {
    const previous = this.operations.get(requestId);
    const task = (async () => {
      await previous?.catch(() => {});
      await this.run(requestId);
    })();
    this.operations.set(requestId, task);
    try {
      await task;
    } finally {
      if (this.operations.get(requestId) === task) this.operations.delete(requestId);
    }
  }
  private record(id: string, state: TransferState, net: number, error: string | null = null) {
    this.store.db
      .prepare(
        'UPDATE transfers SET state = ?, net_amount = ?, checked_at = ?, retry_at = ?, error_code = ? WHERE request_id = ?',
      )
      .run(state, net, this.clock(), error ? this.clock() + 60000 : 0, error, id);
  }
  private complete(id: string, providerId: string) {
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE transfer_operations SET status = 'complete', provider_id = ? WHERE id = ?")
        .run(providerId, id);
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO effects SELECT request_id, kind, ? FROM transfer_operations WHERE id = ?',
        )
        .run(this.clock(), id);
    });
  }
  private async run(requestId: string) {
    const row = this.store.db
      .prepare(
        `SELECT t.*, p.link_id, p.intent_id, p.amount AS payment_amount FROM transfers t
      JOIN payments p ON p.request_id = t.request_id JOIN recipients r ON r.id = t.recipient_id
      WHERE t.request_id = ? AND p.state = 'captured' AND r.provider = ?`,
      )
      .get(requestId, this.provider.mode) as unknown as Row | undefined;
    if (!row) return;
    let net = row.net_amount;
    let recovering = row.state === 'recovery_pending';
    let executing: TransferOperation | null = null;
    try {
      await this.payments.refresh(row.link_id);
      for (let pass = 0; pass < 10; pass++) {
        const actual = await this.provider.transfers(row);
        const adjustment = this.payments.settlement(row.link_id);
        const target = recipientEntitlement(row.payment_amount, row.amount, adjustment);
        const held = adjustment.refundPending > 0 || adjustment.dispute === 'open';
        net = actual.reduce((sum, item) => sum + item.amount - item.reversedAmount, 0);
        recovering = net > target;
        let operation = this.store.db
          .prepare(
            "SELECT * FROM transfer_operations WHERE request_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT 1",
          )
          .get(requestId) as unknown as TransferOperation | undefined;
        if (operation) {
          const completed = await this.provider.findOperation(row, operation);
          if (completed) {
            this.complete(operation.id, completed);
            continue;
          }
          // A timed-out command might still exist at Stripe. Never replace it with another command.
          const compatible =
            operation.kind === 'transfer'
              ? !held && net + operation.amount <= target
              : net - operation.amount >= target;
          if (!compatible) {
            this.record(
              requestId,
              recovering ? 'recovery_pending' : 'held',
              net,
              'UNCONFIRMED_OPERATION',
            );
            return;
          }
        } else if (net > target) {
          const source = actual.find((item) => item.amount > item.reversedAmount);
          if (!source) throw new Error('Missing reversal source');
          operation = {
            id: randomUUID(),
            kind: 'reversal',
            amount: Math.min(net - target, source.amount - source.reversedAmount),
            source_id: source.id,
          };
        } else if (!held && net < target) {
          const tracked = Number(
            this.store.db
              .prepare(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM transfer_operations WHERE request_id = ? AND kind = 'reversal' AND status = 'complete'",
              )
              .get(requestId)!.total,
          );
          if (actual.reduce((sum, item) => sum + item.reversedAmount, 0) > tracked) {
            this.record(requestId, 'held', net, 'EXTERNAL_REVERSAL');
            return;
          }
          operation = { id: randomUUID(), kind: 'transfer', amount: target - net, source_id: null };
        } else {
          this.record(requestId, held ? 'held' : target === 0 ? 'recovered' : 'transferred', net);
          return;
        }
        const inserted = this.store.db
          .prepare(
            "INSERT OR IGNORE INTO transfer_operations (id, request_id, kind, amount, source_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
          )
          .run(
            operation.id,
            requestId,
            operation.kind,
            operation.amount,
            operation.source_id,
            this.clock(),
          );
        // Another process may have reserved the next command after our read.
        if (
          !inserted.changes &&
          !this.store.db.prepare('SELECT 1 FROM transfer_operations WHERE id = ?').get(operation.id)
        )
          continue;
        executing = operation;
        const id =
          operation.kind === 'transfer'
            ? await this.provider.transfer({
                ...row,
                amount: operation.amount,
                operation_id: operation.id,
              })
            : await this.provider.reverse({
                ...row,
                amount: operation.amount,
                operation_id: operation.id,
                transfer_id: operation.source_id!,
              });
        this.complete(operation.id, id);
        executing = null;
      }
      this.record(
        requestId,
        recovering ? 'recovery_pending' : 'pending',
        net,
        'RECONCILIATION_LIMIT',
      );
    } catch (error) {
      if (error instanceof TransferRejected && executing)
        this.store.db
          .prepare(
            "UPDATE transfer_operations SET status = 'failed' WHERE id = ? AND status = 'pending'",
          )
          .run(executing.id);
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[a-zA-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'PROVIDER_UNAVAILABLE';
      this.record(requestId, recovering ? 'recovery_pending' : 'pending', net, code);
      throw error;
    }
  }
  async reconcile() {
    const rows = this.store.db
      .prepare(
        `SELECT t.request_id FROM transfers t JOIN payments p ON p.request_id = t.request_id
      JOIN recipients r ON r.id = t.recipient_id WHERE p.state = 'captured' AND r.provider = ? AND t.retry_at <= ? AND
      (t.checked_at = 0 OR (t.state IN ('pending', 'recovery_pending') AND t.checked_at <= ?) OR t.checked_at <= ?)
      ORDER BY t.checked_at LIMIT 20`,
      )
      .all(this.provider.mode, this.clock(), this.clock() - 10000, this.clock() - 900000);
    for (const row of rows) {
      try {
        await this.settle(String(row.request_id));
      } catch {
        /* State and reason are recorded for the next attempt and operator review. */
      }
    }
  }
}
