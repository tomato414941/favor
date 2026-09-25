import { randomUUID } from 'node:crypto';
import type { RecipientState, RecipientView } from '../shared.js';
import { DomainError } from './errors.js';
import type { ConnectProvider, Recipient } from './connect-provider.js';
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
}
