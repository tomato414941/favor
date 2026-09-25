import type { PaymentState, SettlementView } from '../shared.js';
import { DomainError } from './errors.js';
import type { Adjustment, CardPayment, CardStatus, PaymentProvider } from './payment-provider.js';
import { Store } from './store.js';

export interface PaymentRow extends CardPayment {
  request_id: string | null;
  provider: string;
  state: PaymentState;
  checkout_url: string | null;
  checked_at: number;
  charge_id: string | null;
}

export class Payments {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    readonly store: Store,
    readonly provider: PaymentProvider,
    readonly clock = Date.now,
  ) {}
  row(id: string): PaymentRow {
    const row = this.store.db
      .prepare('SELECT * FROM payments WHERE link_id = ?')
      .get(id) as unknown as PaymentRow | undefined;
    if (!row) throw new DomainError('PAYMENT_UNAVAILABLE', '支払いの状態を確認できません。', 503);
    return row;
  }
  settlement(id: string): SettlementView {
    const items = this.store.db
      .prepare('SELECT * FROM adjustments WHERE link_id = ?')
      .all(id) as unknown as Adjustment[];
    const refunds = items.filter((item) => item.kind === 'refund');
    const disputes = items.filter((item) => item.kind === 'dispute');
    const open = disputes.filter(
      (item) => !['won', 'lost', 'warning_closed', 'prevented'].includes(item.status),
    );
    const sum = (rows: Adjustment[]) => rows.reduce((total, item) => total + item.amount, 0);
    return {
      refunded: sum(refunds.filter((item) => item.status === 'succeeded')),
      refundPending: sum(
        refunds.filter((item) => !['succeeded', 'failed', 'canceled'].includes(item.status)),
      ),
      refundFailed: sum(refunds.filter((item) => item.status === 'failed')),
      dispute: open.length
        ? 'open'
        : disputes.some((item) => item.status === 'lost')
          ? 'lost'
          : disputes.some((item) => item.status === 'won')
            ? 'won'
            : 'none',
      disputedAmount: sum(disputes.filter((item) => item.status === 'lost')),
    };
  }
  private async syncAdjustments(row: PaymentRow) {
    const items = await this.provider.adjustments(row);
    for (const item of items) {
      if (
        !Number.isSafeInteger(item.amount) ||
        item.amount <= 0 ||
        item.amount > row.amount ||
        !item.id ||
        !item.status
      )
        throw new DomainError('PAYMENT_MISMATCH', '支払いの状態を確認できません。', 502);
    }
    if (
      items
        .filter((item) => item.kind === 'refund' && item.status === 'succeeded')
        .reduce((sum, item) => sum + item.amount, 0) > row.amount
    )
      throw new DomainError('PAYMENT_MISMATCH', '支払いの状態を確認できません。', 502);
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM adjustments WHERE link_id = ?').run(row.link_id);
      const insert = this.store.db.prepare(
        'INSERT INTO adjustments VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const item of items)
        insert.run(
          item.id,
          row.link_id,
          item.kind,
          item.amount,
          item.status,
          item.reason,
          item.respondBy,
          this.clock(),
        );
      this.store.db
        .prepare('UPDATE payments SET checked_at = ? WHERE link_id = ?')
        .run(this.clock(), row.link_id);
    });
  }
  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, current);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
  async start(id: string): Promise<PaymentRow> {
    return this.exclusive(id, async () => {
      await this.prepare(id);
      return this.row(id);
    });
  }
  private async prepare(id: string) {
    const row = this.row(id);
    if (row.provider !== this.provider.mode)
      throw new DomainError('PAYMENT_UNAVAILABLE', '支払いの状態を確認できません。', 503);
    if (row.checkout_id) return;
    const checkout = await this.provider.checkout(row);
    this.store.db
      .prepare(
        'UPDATE payments SET checkout_id = ?, checkout_url = ? WHERE link_id = ? AND checkout_id IS NULL',
      )
      .run(checkout.id, checkout.url, id);
  }
  private apply(id: string, status: CardStatus) {
    this.store.transaction(() => {
      const row = this.row(id);
      if (['captured', 'released'].includes(row.state)) {
        if (status.state !== row.state)
          throw new DomainError('PAYMENT_MISMATCH', '支払いの状態を確認できません。', 502);
        return;
      }
      if (status.state === 'captured') {
        if (row.state !== 'capturing' || !row.request_id)
          throw new DomainError('PAYMENT_MISMATCH', '支払いの状態を確認できません。', 502);
        const request = this.store.db
          .prepare("SELECT * FROM requests WHERE id = ? AND state = 'delivering'")
          .get(row.request_id);
        if (!request) throw new Error('A captured payment must have a staged delivery.');
        this.store.db
          .prepare(
            "UPDATE requests SET state = 'delivered', delivery_version = delivery_version + 1 WHERE id = ?",
          )
          .run(row.request_id);
        for (const effect of ['capture', 'sale'])
          this.store.db
            .prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)')
            .run(row.request_id, effect, this.clock());
        this.store.db
          .prepare('INSERT INTO audit (request_id, actor_id, action, at) VALUES (?, ?, ?, ?)')
          .run(row.request_id, request.creator_id!, 'deliver', this.clock());
      }
      if (status.state === 'released') {
        this.store.db
          .prepare(
            "UPDATE request_links SET state = 'cancelled', cancelled_reason = COALESCE(cancelled_reason, 'payment_expired') WHERE id = ? AND state IN ('awaiting_payment', 'pending')",
          )
          .run(id);
        if (row.request_id) {
          this.store.db
            .prepare(
              "UPDATE requests SET state = 'cancelled', cancelled_reason = COALESCE(cancelled_reason, 'payment_expired') WHERE id = ? AND state IN ('accepted', 'delivering')",
            )
            .run(row.request_id);
          this.store.db
            .prepare(
              'DELETE FROM files WHERE request_id = ? AND version > (SELECT delivery_version FROM requests WHERE id = ?)',
            )
            .run(row.request_id, row.request_id);
          this.store.db
            .prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)')
            .run(row.request_id, 'release', this.clock());
        }
      }
      // Durable capture/release requests take priority over an earlier authorization snapshot.
      const state =
        ['capturing', 'releasing'].includes(row.state) &&
        ['pending', 'authorized'].includes(status.state)
          ? row.state
          : status.state;
      this.store.db
        .prepare(
          'UPDATE payments SET state = ?, intent_id = COALESCE(?, intent_id), charge_id = COALESCE(?, charge_id), hold_until = ?, checked_at = ? WHERE link_id = ?',
        )
        .run(
          state,
          status.intentId,
          status.chargeId ?? null,
          status.holdUntil || row.hold_until,
          this.clock(),
          id,
        );
    });
  }
  async refresh(id: string): Promise<PaymentRow> {
    return this.exclusive(id, async () => {
      const row = this.row(id);
      if (row.provider !== this.provider.mode)
        throw new DomainError('PAYMENT_UNAVAILABLE', '支払いの状態を確認できません。', 503);
      if (row.state === 'released') return row;
      if (row.state === 'captured') {
        await this.syncAdjustments(row);
        return this.row(id);
      }
      await this.prepare(id);
      this.apply(id, await this.provider.inspect(this.row(id)));
      if (this.row(id).state === 'captured') await this.syncAdjustments(this.row(id));
      return this.row(id);
    });
  }
  /** Called in the same SQLite transaction as the corresponding domain change. */
  requestRelease(id: string) {
    const row = this.row(id);
    if (['capturing', 'captured'].includes(row.state))
      throw new DomainError('PAYMENT_BUSY', '納品の確認中です。時間をおいてご確認ください。');
    this.store.db
      .prepare(
        "UPDATE payments SET state = 'releasing', checked_at = 0 WHERE link_id = ? AND state IN ('pending', 'authorized')",
      )
      .run(id);
  }
  async settle(id: string): Promise<PaymentRow> {
    return this.exclusive(id, async () => {
      let row = this.row(id);
      if (!['capturing', 'releasing'].includes(row.state)) return row;
      // The Checkout URL is returned only after its ID is saved. Without that ID,
      // card entry never started, so there is no authorization to release.
      if (row.state === 'releasing' && !row.checkout_id) {
        this.apply(id, { state: 'released', intentId: null, holdUntil: 0 });
        return this.row(id);
      }
      this.store.db
        .prepare('UPDATE payments SET checked_at = ? WHERE link_id = ?')
        .run(this.clock(), id);
      await this.prepare(id);
      row = this.row(id);
      const status =
        row.state === 'capturing'
          ? await this.provider.capture(row)
          : await this.provider.release(row);
      this.apply(id, status);
      return this.row(id);
    });
  }
  async webhook(body: Buffer, signature: string) {
    if (!this.provider.event) throw new DomainError('NOT_FOUND', 'ページが見つかりません。', 404);
    const event = this.provider.event(body, signature);
    if (!event || this.store.db.prepare('SELECT 1 FROM payment_events WHERE id = ?').get(event.id))
      return;
    const row = this.store.db
      .prepare(
        'SELECT * FROM payments WHERE provider = ? AND (link_id = ? OR intent_id = ? OR charge_id = ? OR request_id = ?)',
      )
      .get(
        this.provider.mode,
        event.linkId ?? null,
        event.intentId ?? null,
        event.chargeId ?? null,
        event.requestId ?? null,
      ) as unknown as PaymentRow | undefined;
    if (!row) return;
    if (event.checkoutId && !row.checkout_id)
      this.store.db
        .prepare('UPDATE payments SET checkout_id = ? WHERE link_id = ? AND checkout_id IS NULL')
        .run(event.checkoutId, row.link_id);
    await this.refresh(row.link_id);
    await this.settle(row.link_id);
    this.store.db
      .prepare('UPDATE transfers SET checked_at = 0, retry_at = 0 WHERE request_id = ?')
      .run(row.request_id);
    this.store.db
      .prepare('INSERT OR IGNORE INTO payment_events VALUES (?, ?)')
      .run(event.id, row.link_id);
  }
  /** Retry unfinished operations after timeouts or restarts. Each payment keeps the same provider idempotency keys. */
  async reconcile() {
    const rows = this.store.db
      .prepare(
        `SELECT link_id, state FROM payments WHERE provider = ? AND
      ((state IN ('capturing', 'releasing') AND checked_at <= ?) OR
       (state IN ('pending', 'authorized') AND checkout_id IS NOT NULL AND checked_at <= ?) OR
       (state = 'captured' AND checked_at <= ?))
      ORDER BY checked_at LIMIT 20`,
      )
      .all(this.provider.mode, this.clock() - 5000, this.clock() - 60000, this.clock() - 900000);
    for (const row of rows) {
      const id = String(row.link_id);
      try {
        this.store.db
          .prepare('UPDATE payments SET checked_at = ? WHERE link_id = ?')
          .run(this.clock(), id);
        if (['capturing', 'releasing'].includes(String(row.state))) await this.settle(id);
        else await this.refresh(id);
      } catch {
        /* Persisted operations are retried on the next pass. Never report unconfirmed release. */
      }
    }
  }
}
