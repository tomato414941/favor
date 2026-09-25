import { randomUUID } from 'node:crypto';
import type { RecipientState, RecipientView } from '../shared.js';
import { DomainError } from './errors.js';
import type { ConnectProvider, Recipient, Transfer } from './connect-provider.js';
import type { Store } from './store.js';

interface RecipientRow extends Recipient {
  user_id: string;
  provider: string;
  state: RecipientState;
}
export class Recipients {
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly provider: ConnectProvider,
    readonly clock = Date.now,
  ) {}
  private async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key);
    const task = (async () => {
      await previous?.catch(() => {});
      return run();
    })();
    this.operations.set(key, task);
    try {
      return await task;
    } finally {
      if (this.operations.get(key) === task) this.operations.delete(key);
    }
  }
  private row(actor: string): RecipientRow | undefined {
    if (!this.store.db.prepare('SELECT 1 FROM users WHERE id = ?').get(actor))
      throw new DomainError('UNAUTHORIZED', 'ログインしてください。', 401);
    const row = this.store.db
      .prepare('SELECT * FROM recipients WHERE user_id = ?')
      .get(actor) as unknown as RecipientRow | undefined;
    if (row && row.provider !== this.provider.mode)
      throw new DomainError('CONNECT_UNAVAILABLE', '受取先を確認できません。', 503);
    return row;
  }
  async status(actor: string): Promise<RecipientView> {
    return this.exclusive(actor, async () => {
      const row = this.row(actor);
      if (!row?.account_id) return { state: 'unregistered' };
      const state = await this.provider.inspect(row);
      this.store.db.prepare('UPDATE recipients SET state = ? WHERE id = ?').run(state, row.id);
      return { state };
    });
  }
  async requireReady(actor: string) {
    const status = await this.status(actor);
    if (status.state !== 'ready')
      throw new DomainError('RECIPIENT_REQUIRED', '受取先を登録してください。');
    return this.row(actor)!;
  }
  async onboard(actor: string, origin: string) {
    return this.exclusive(actor, async () => {
      if (!this.row(actor))
        this.store.db
          .prepare(
            "INSERT INTO recipients (id, user_id, provider, state) VALUES (?, ?, ?, 'unregistered')",
          )
          .run(randomUUID(), actor, this.provider.mode);
      let row = this.row(actor)!;
      if (!row.account_id) {
        const email = this.store.db
          .prepare('SELECT email FROM users WHERE id = ?')
          .get(actor)?.email;
        if (typeof email !== 'string' || !email)
          throw new DomainError('EMAIL_REQUIRED', 'メールアドレスを確認してください。');
        const id = await this.provider.create(row, email);
        this.store.db
          .prepare("UPDATE recipients SET account_id = ?, state = 'incomplete' WHERE id = ?")
          .run(id, row.id);
        row = this.row(actor)!;
      }
      return { url: await this.provider.onboarding(row, origin) };
    });
  }
  async dashboard(actor: string) {
    const row = this.row(actor);
    if (!row?.account_id) throw new DomainError('RECIPIENT_REQUIRED', '受取先を登録してください。');
    return { url: await this.provider.dashboard(row) };
  }
  /** Bind the beneficiary and amount in the transaction that accepts the request. */
  bind(actor: string, requestId: string, amount: number) {
    const row = this.row(actor);
    if (!row?.account_id || row.state !== 'ready')
      throw new DomainError('RECIPIENT_REQUIRED', '受取先を登録してください。');
    this.store.db
      .prepare(
        "INSERT INTO transfers (request_id, recipient_id, account_id, amount, state) VALUES (?, ?, ?, ?, 'pending')",
      )
      .run(requestId, row.id, row.account_id, amount);
  }
  async settle(requestId: string) {
    return this.exclusive(`transfer:${requestId}`, async () => {
      const row = this.store.db
        .prepare(
          `SELECT t.*, p.link_id, p.intent_id, p.amount AS payment_amount FROM transfers t
        JOIN payments p ON p.request_id = t.request_id
        JOIN recipients a ON a.id = t.recipient_id
        WHERE t.request_id = ? AND t.state = 'pending' AND p.state = 'captured' AND a.provider = ?`,
        )
        .get(requestId, this.provider.mode) as unknown as Transfer | undefined;
      if (!row) return;
      this.store.db
        .prepare('UPDATE transfers SET checked_at = ? WHERE request_id = ?')
        .run(this.clock(), requestId);
      const id = await this.provider.transfer(row);
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE transfers SET state = 'transferred', transfer_id = ? WHERE request_id = ?",
          )
          .run(id, requestId);
        this.store.db
          .prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)')
          .run(requestId, 'transfer', this.clock());
      });
    });
  }
  async reconcile() {
    const rows = this.store.db
      .prepare(
        `SELECT t.request_id FROM transfers t
      JOIN payments p ON p.request_id = t.request_id JOIN recipients a ON a.id = t.recipient_id
      WHERE t.state = 'pending' AND p.state = 'captured' AND a.provider = ? AND t.checked_at <= ?
      ORDER BY t.checked_at LIMIT 20`,
      )
      .all(this.provider.mode, this.clock() - 10000);
    for (const row of rows) {
      try {
        await this.settle(String(row.request_id));
      } catch {
        /* Retry the saved obligation with the same beneficiary and idempotency key. */
      }
    }
  }
}
