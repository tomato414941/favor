import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type {
  ProfileView,
  RequestLinkInput,
  RequestState,
  RequestView,
  SessionView,
  UploadInput,
  Visibility,
  WorkView,
} from '../shared.js';
import { commandFingerprint } from './fingerprint.js';
import { Store } from './store.js';
import { DomainError } from './errors.js';
import { Payments, type PaymentRow } from './payments.js';
import { MockPayments, type PaymentProvider } from './payment-provider.js';
import { MockConnect, type ConnectProvider } from './connect-provider.js';
import { Recipients } from './recipients.js';
export { DomainError } from './errors.js';

const DAY = 86_400_000;
export const DEMO_POLICY = {
  acceptanceMs: 7 * DAY,
  deliveryMs: 30 * DAY,
  authorizationMs: 30 * DAY,
  recommendedAmount: 1000,
  minimumAmount: 1000,
  maximumAmount: 299999,
  maximumBriefLength: 2000,
  maximumNameLength: 40,
  maximumFiles: 24,
  maximumUploadBytes: 8 * 1024 * 1024,
};
type Policy = typeof DEMO_POLICY;
interface UserRow {
  id: string;
  name: string;
  display_name: string | null;
}
interface RequestRow {
  id: string;
  client_id: string;
  creator_id: string;
  brief: string;
  amount: number;
  platform_fee: number;
  visibility: Visibility;
  state: RequestState;
  created_at: number;
  accept_by: number;
  deliver_by: number;
  cancelled_reason: string | null;
  delivery_version: number;
}
interface FileRow {
  id: string;
  request_id: string;
  name: string;
  data: Uint8Array;
}
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
export const imageType = (name: string): string | null =>
  IMAGE_TYPES[name.toLowerCase().split('.').pop() ?? ''] ?? null;
const fail = (code: string, message: string, status = 409): never => {
  throw new DomainError(code, message, status);
};
export class RequestService {
  readonly policy: Policy;
  readonly payments: Payments;
  readonly recipients: Recipients;
  constructor(
    readonly store: Store,
    readonly clock: () => number = Date.now,
    policy: Partial<Policy> = {},
    provider?: PaymentProvider,
    connect: ConnectProvider = new MockConnect(),
  ) {
    this.policy = { ...DEMO_POLICY, ...policy };
    this.payments = new Payments(
      store,
      provider ?? new MockPayments(clock, { holdMs: this.policy.authorizationMs }),
      clock,
    );
    this.recipients = new Recipients(store, connect, clock);
  }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.store.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  /** The name others see: the one the person chose, else the one their sign-in provides. */
  private user(id: string): UserRow {
    return (
      this.one<UserRow>(
        'SELECT id, COALESCE(display_name, name) AS name, display_name FROM users WHERE id = ?',
        id,
      ) ?? fail('UNAUTHORIZED', 'ログインしてください。', 401)
    );
  }
  profile(actor: string): ProfileView {
    const row = this.user(actor);
    return { name: row.name, displayName: row.display_name };
  }
  setDisplayName(actor: string, input: unknown): ProfileView {
    this.user(actor);
    const value = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
    if (value.length > this.policy.maximumNameLength || /[\x00-\x1f\x7f]/.test(value))
      fail(
        'INVALID_NAME',
        `表示名は${this.policy.maximumNameLength}文字以内で入力してください。`,
        400,
      );
    this.store.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(value || null, actor);
    return this.profile(actor);
  }
  private row(id: string): RequestRow {
    return (
      this.one<RequestRow>('SELECT * FROM requests WHERE id = ?', id) ??
      fail('NOT_FOUND', '依頼が見つかりません。', 404)
    );
  }
  private payment(id: string): PaymentRow {
    return (
      this.one<PaymentRow>('SELECT * FROM payments WHERE request_id = ?', id) ??
      fail('NOT_FOUND', '支払いが見つかりません。', 404)
    );
  }
  private participant(actor: string, row: RequestRow) {
    if (actor !== row.client_id && actor !== row.creator_id)
      fail('NOT_FOUND', '依頼が見つかりません。', 404);
  }
  private effect(id: string, operation: string): boolean {
    return (
      Number(
        this.store.db
          .prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)')
          .run(id, operation, this.clock()).changes,
      ) === 1
    );
  }
  private audit(id: string, actor: string, action: string) {
    this.store.db
      .prepare('INSERT INTO audit (request_id, actor_id, action, at) VALUES (?, ?, ?, ?)')
      .run(id, actor, action, this.clock());
  }
  session(actor: string): SessionView {
    return { name: this.user(actor).name };
  }
  private workView(row: RequestRow, actor?: string): WorkView {
    return {
      id: row.id,
      brief: row.brief,
      clientName:
        row.visibility === 'anonymous' && actor !== row.client_id
          ? '匿名の依頼者'
          : this.user(row.client_id).name,
      creatorName: this.user(row.creator_id).name,
      visibility: row.visibility,
      state: row.state,
      createdAt: row.created_at,
      acceptBy: row.accept_by,
      deliverBy: row.deliver_by,
      deliveryVersion: row.delivery_version,
      files: this.store.db
        .prepare(
          'SELECT id, name, length(data) AS size FROM files WHERE request_id = ? AND version = ?',
        )
        .all(row.id, row.delivery_version) as unknown as WorkView['files'],
    };
  }
  private view(row: RequestRow, actor: string): RequestView {
    return {
      ...this.workView(row, actor),
      viewerRole: actor === row.client_id ? 'client' : 'creator',
      amount: row.amount,
      platformFee: row.platform_fee,
      recipientAmount: row.amount - row.platform_fee,
      paymentState: this.payment(row.id).state,
      transferState:
        this.one<{ state: 'pending' | 'transferred' }>(
          'SELECT state FROM transfers WHERE request_id = ?',
          row.id,
        )?.state ?? null,
      cancelledReason: row.cancelled_reason,
    };
  }
  get(actor: string, id: string): RequestView {
    this.expire();
    this.user(actor);
    const row = this.row(id);
    this.participant(actor, row);
    return this.view(row, actor);
  }
  list(actor: string): RequestView[] {
    this.expire();
    this.user(actor);
    const rows = this.store.db
      .prepare(
        'SELECT * FROM requests WHERE client_id = ? OR creator_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(actor, actor) as unknown as RequestRow[];
    return rows.map((row) => this.view(row, actor));
  }
  publicWorks(): WorkView[] {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM requests WHERE state = 'delivered' AND visibility != 'hidden' ORDER BY created_at DESC",
      )
      .all() as unknown as RequestRow[];
    return rows.map((row) => this.workView(row));
  }
  private publicRow(id: string): RequestRow {
    const row = this.one<RequestRow>('SELECT * FROM requests WHERE id = ?', id);
    if (!row || row.state !== 'delivered' || row.visibility === 'hidden')
      fail('NOT_FOUND', '作品が見つかりません。', 404);
    return row!;
  }
  publicWork(id: string): WorkView {
    return this.workView(this.publicRow(id));
  }
  /** Image files of the latest delivery of a public work. Other files stay with the parties. */
  publicImage(id: string, fileId: string): FileRow & { type: string } {
    const row = this.publicRow(id);
    const file = this.one<FileRow & { version: number }>(
      'SELECT id, request_id, version, name, data FROM files WHERE id = ? AND request_id = ?',
      fileId,
      id,
    );
    const type = file && imageType(file.name);
    if (!file || file.version !== row.delivery_version || !type)
      fail('NOT_FOUND', 'ファイルが見つかりません。', 404);
    return { ...file!, type: type! };
  }
  private command(
    actor: string,
    scope: string,
    key: string,
    payload: unknown,
    run: () => string,
  ): RequestView {
    this.user(actor);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      fail('BAD_KEY', '操作を再読み込みしてお試しください。', 400);
    const fingerprint = commandFingerprint(payload);
    const id = this.store.transaction(() => {
      const existing = this.one<{ fingerprint: string; request_id: string }>(
        'SELECT * FROM commands WHERE actor_id = ? AND scope = ? AND key = ?',
        actor,
        scope,
        key,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          fail('KEY_REUSED', '同じ操作キーで内容を変更することはできません。');
        return existing.request_id;
      }
      const result = run();
      this.store.db
        .prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)')
        .run(actor, scope, key, fingerprint, result);
      return result;
    });
    return this.get(actor, id);
  }
  /** Acceptance keeps the existing card authorization until delivery. */
  receiveLink(
    actor: string,
    clientId: string,
    input: RequestLinkInput,
    dates: { createdAt: number; expiresAt: number; deliverBy: number },
    linkId: string,
  ): RequestView {
    return this.store.transaction(() => {
      this.user(clientId);
      this.user(actor);
      if (actor === clientId) fail('FORBIDDEN', 'この依頼は受け取れません。', 403);
      const payment = this.payments.row(linkId);
      if (payment.state !== 'authorized' || payment.amount !== input.amount)
        fail('INVALID_PAYMENT', '支払いの仮押さえを確認できません。');
      const link = this.one<{ platform_fee: number }>(
        'SELECT platform_fee FROM request_links WHERE id = ?',
        linkId,
      )!;
      if (this.clock() >= Math.min(dates.expiresAt, dates.deliverBy, payment.hold_until))
        fail('LINK_EXPIRED', '依頼リンクの有効期限を過ぎました。');
      const id = randomUUID();
      this.store.db
        .prepare(
          `INSERT INTO requests
        (id, client_id, creator_id, brief, amount, platform_fee, visibility, state, created_at, accept_by, deliver_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
        )
        .run(
          id,
          clientId,
          actor,
          input.brief,
          input.amount,
          link.platform_fee,
          input.visibility,
          dates.createdAt,
          dates.expiresAt,
          dates.deliverBy,
        );
      this.store.db.prepare('UPDATE payments SET request_id = ? WHERE link_id = ?').run(id, linkId);
      this.recipients.bind(actor, id, input.amount - link.platform_fee);
      this.effect(id, 'authorize');
      this.audit(id, actor, 'accept');
      return this.view(this.row(id), actor);
    });
  }
  private cancelInternal(id: string, reason: string, actor: string) {
    const row = this.row(id);
    const payment = this.payment(id);
    this.payments.requestRelease(payment.link_id);
    if (row.state !== 'cancelled') {
      this.store.db
        .prepare("UPDATE requests SET state = 'cancelled', cancelled_reason = ? WHERE id = ?")
        .run(reason, id);
      this.audit(id, actor, reason);
    }
  }
  async cancel(actor: string, id: string, key: string): Promise<RequestView> {
    this.expire();
    this.command(actor, `cancel:${id}`, key, {}, () => {
      const row = this.row(id);
      this.participant(actor, row);
      if (row.state === 'cancelled') return id;
      if (row.state === 'accepted' && actor === row.creator_id)
        this.cancelInternal(id, 'give_up', actor);
      else fail('INVALID_STATE', 'この依頼は取り消せません。');
      return id;
    });
    await this.payments.settle(this.payment(id).link_id);
    return this.get(actor, id);
  }
  expire(): number {
    return this.store.transaction(() => {
      const now = this.clock();
      const rows = this.store.db
        .prepare(
          `SELECT r.* FROM requests r JOIN payments p ON r.id = p.request_id
        WHERE r.state = 'accepted' AND (r.deliver_by <= ? OR p.hold_until <= ?)`,
        )
        .all(now, now) as unknown as RequestRow[];
      for (const row of rows) this.cancelInternal(row.id, 'delivery_expired', 'system');
      return rows.length;
    });
  }
  async deliver(
    actor: string,
    id: string,
    key: string,
    files: UploadInput[],
  ): Promise<RequestView> {
    this.expire();
    const request = this.row(id);
    this.participant(actor, request);
    if (actor !== request.creator_id)
      fail('FORBIDDEN', '納品できるのは依頼先の作り手だけです。', 403);
    if (request.state === 'accepted') await this.recipients.requireReady(actor);
    if (!Array.isArray(files) || files.length < 1 || files.length > this.policy.maximumFiles)
      fail(
        'INVALID_FILES',
        `納品ファイルは1〜${this.policy.maximumFiles}個で選んでください。`,
        400,
      );
    let total = 0;
    const buffers = files.map((file) => {
      if (
        typeof file.name !== 'string' ||
        !file.name.trim() ||
        file.name.length > 180 ||
        /[\x00-\x1f\x7f/\\]/.test(file.name)
      )
        fail('INVALID_FILE_NAME', 'ファイル名を確認してください。', 400);
      if (
        typeof file.content !== 'string' ||
        file.content.length > Math.ceil(this.policy.maximumUploadBytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
      )
        fail('INVALID_FILE', 'ファイルを読み取れませんでした。', 400);
      const buffer = Buffer.from(file.content, 'base64');
      if (buffer.toString('base64') !== file.content)
        fail('INVALID_FILE', 'ファイルを読み取れませんでした。', 400);
      total += buffer.length;
      if (!buffer.length || total > this.policy.maximumUploadBytes)
        fail('FILE_TOO_LARGE', 'ファイルは合計8 MB以内で選んでください。', 400);
      return buffer;
    });
    this.command(actor, `deliver:${id}`, key, files, () => {
      const row = this.row(id);
      this.participant(actor, row);
      if (actor !== row.creator_id)
        fail('FORBIDDEN', '納品できるのは依頼先の作り手だけです。', 403);
      if (!['accepted', 'delivered'].includes(row.state) || this.clock() >= row.deliver_by)
        fail('INVALID_STATE', 'この依頼には納品できません。');
      const payment = this.payment(id);
      if (!['authorized', 'captured'].includes(payment.state))
        fail('INVALID_PAYMENT', '支払いの状態を確認できません。');
      const version = row.delivery_version + 1;
      files.forEach((file, index) =>
        this.store.db
          .prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)')
          .run(randomUUID(), id, version, file.name, buffers[index]!),
      );
      if (payment.state === 'captured') {
        this.store.db
          .prepare("UPDATE requests SET state = 'delivered', delivery_version = ? WHERE id = ?")
          .run(version, id);
        this.audit(id, actor, 'redeliver');
      } else {
        this.store.db.prepare("UPDATE requests SET state = 'delivering' WHERE id = ?").run(id);
        this.store.db
          .prepare("UPDATE payments SET state = 'capturing', checked_at = 0 WHERE request_id = ?")
          .run(id);
      }
      return id;
    });
    await this.payments.settle(this.payment(id).link_id);
    try {
      await this.recipients.settle(id);
    } catch {
      /* Capture succeeded; retry the saved transfer without charging again. */
    }
    return this.get(actor, id);
  }
  download(actor: string, requestId: string, fileId: string): FileRow {
    this.user(actor);
    const file =
      this.one<FileRow>(
        `SELECT f.id, f.request_id, f.name, f.data FROM files f JOIN requests r ON r.id = f.request_id
         JOIN payments p ON p.request_id = r.id WHERE f.id = ? AND f.request_id = ?
         AND f.version <= r.delivery_version AND p.state = 'captured'`,
        fileId,
        requestId,
      ) ?? fail('NOT_FOUND', 'ファイルが見つかりません。', 404);
    this.participant(actor, this.row(file.request_id));
    return file;
  }
}
