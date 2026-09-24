import type { PaymentState } from '../shared.js';
import { DomainError } from './errors.js';
import type { CardPayment, CardStatus, PaymentProvider } from './payment-provider.js';
import { Store } from './store.js';

export interface PaymentRow extends CardPayment {
  request_id: string | null;
  provider: string;
  state: PaymentState;
  checkout_url: string | null;
  checked_at: number;
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
      if (['captured', 'released'].includes(row.state)) return;
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
          'UPDATE payments SET state = ?, intent_id = COALESCE(?, intent_id), hold_until = ?, checked_at = ? WHERE link_id = ?',
        )
        .run(state, status.intentId, status.holdUntil || row.hold_until, this.clock(), id);
    });
  }
  async refresh(id: string): Promise<PaymentRow> {
    return this.exclusive(id, async () => {
      const row = this.row(id);
      if (['released', 'captured'].includes(row.state)) return row;
      await this.prepare(id);
      this.apply(id, await this.provider.inspect(this.row(id)));
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
      .prepare('SELECT * FROM payments WHERE link_id = ? AND provider = ?')
      .get(event.linkId, this.provider.mode) as unknown as PaymentRow | undefined;
    if (!row) return;
    if (event.checkoutId && !row.checkout_id)
      this.store.db
        .prepare('UPDATE payments SET checkout_id = ? WHERE link_id = ? AND checkout_id IS NULL')
        .run(event.checkoutId, event.linkId);
    await this.refresh(event.linkId);
    await this.settle(event.linkId);
    this.store.db
      .prepare('INSERT OR IGNORE INTO payment_events VALUES (?, ?)')
      .run(event.id, event.linkId);
  }
  /** Retry unfinished operations after timeouts or restarts. Each payment keeps the same provider idempotency keys. */
  async reconcile() {
    const rows = this.store.db
      .prepare(
        `SELECT link_id, state FROM payments WHERE provider = ? AND
      ((state IN ('capturing', 'releasing') AND checked_at <= ?) OR
       (state IN ('pending', 'authorized') AND checkout_id IS NOT NULL AND checked_at <= ?))
      ORDER BY checked_at LIMIT 20`,
      )
      .all(this.provider.mode, this.clock() - 5000, this.clock() - 60000);
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
