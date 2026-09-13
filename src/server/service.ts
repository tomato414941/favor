import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { genres, type CreatorView, type PaymentMethod, type PaymentState, type RequestInput, type RequestState, type RequestView, type SessionView, type UploadInput, type Visibility } from '../shared.js';
import { Store } from './store.js';

const DAY = 86_400_000;
export const DEMO_POLICY = {
  acceptanceMs: 7 * DAY, deliveryMs: 30 * DAY, authorizationMs: 7 * DAY,
  recommendedAmount: 12000, minimumAmount: 1000, maximumAmount: 299999,
  maximumBriefLength: 2000, maximumFiles: 24, maximumUploadBytes: 8 * 1024 * 1024,
};
type Policy = typeof DEMO_POLICY;
interface UserRow { id: string; name: string; role: 'client' | 'creator'; points: number }
interface RequestRow {
  id: string; client_id: string; creator_id: string; genre: RequestInput['genre'];
  brief: string; amount: number; visibility: Visibility; nsfw: number; state: RequestState;
  created_at: number; accept_by: number; deliver_by: number;
  cancelled_reason: string | null; delivery_version: number;
}
interface PaymentRow {
  request_id: string; method: PaymentMethod; state: PaymentState;
  amount: number; hold_until: number; capture_requested: number;
}
interface FileRow { id: string; request_id: string; name: string; data: Uint8Array }
export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) { super(message); }
}
const fail = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class CommissionService {
  readonly policy: Policy;
  constructor(
    readonly store: Store,
    readonly clock: () => number = Date.now,
    policy: Partial<Policy> = {},
    readonly mock: { failAuthorization?: boolean; failCapture?: boolean; deferCardCapture?: boolean } = {},
  ) {
    this.policy = { ...DEMO_POLICY, ...policy };
  }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.store.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  private user(id: string): UserRow {
    return this.one<UserRow>('SELECT * FROM users WHERE id = ?', id) ?? fail('UNAUTHORIZED', '利用者を選択してください。', 401);
  }
  private row(id: string): RequestRow {
    return this.one<RequestRow>('SELECT * FROM requests WHERE id = ?', id) ?? fail('NOT_FOUND', '依頼が見つかりません。', 404);
  }
  private payment(id: string): PaymentRow {
    return this.one<PaymentRow>('SELECT * FROM payments WHERE request_id = ?', id) ?? fail('NOT_FOUND', '支払いが見つかりません。', 404);
  }
  private participant(actor: string, row: RequestRow) {
    if (actor !== row.client_id && actor !== row.creator_id) fail('NOT_FOUND', '依頼が見つかりません。', 404);
  }
  private effect(id: string, operation: string): boolean {
    return Number(this.store.db.prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)').run(id, operation, this.clock()).changes) === 1;
  }
  private audit(id: string, actor: string, action: string) {
    this.store.db.prepare('INSERT INTO audit (request_id, actor_id, action, at) VALUES (?, ?, ?, ?)').run(id, actor, action, this.clock());
  }
  private availablePoints(actor: string): number {
    const held = this.one<{ total: number }>(`SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p
      JOIN requests r ON r.id = p.request_id WHERE r.client_id = ? AND p.method = 'points' AND p.state = 'authorized'`, actor)!.total;
    return this.user(actor).points - held;
  }
  session(actor: string): SessionView {
    this.expire();
    const user = this.user(actor);
    return { role: user.role, name: user.name, pointsBalance: user.points, pointsAvailable: this.availablePoints(actor) };
  }
  creator(): CreatorView {
    return { id: 'demo-creator', name: this.user('demo-creator').name,
      recommendedAmount: this.policy.recommendedAmount, minimumAmount: this.policy.minimumAmount,
      acceptanceDays: this.policy.acceptanceMs / DAY, deliveryDays: this.policy.deliveryMs / DAY };
  }
  private view(row: RequestRow, actor?: string): RequestView {
    const party = actor === row.client_id || actor === row.creator_id;
    const payment = this.payment(row.id);
    return {
      id: row.id, genre: row.genre, brief: row.brief,
      clientName: row.visibility === 'anonymous' && actor !== row.client_id ? '匿名の依頼者' : this.user(row.client_id).name,
      creatorName: this.user(row.creator_id).name, visibility: row.visibility, nsfw: Boolean(row.nsfw),
      state: row.state, createdAt: row.created_at, acceptBy: row.accept_by, deliverBy: row.deliver_by,
      cancelledReason: party ? row.cancelled_reason : null, deliveryVersion: row.delivery_version,
      files: party ? this.store.db.prepare('SELECT id, name, length(data) AS size FROM files WHERE request_id = ? AND version = ?').all(row.id, row.delivery_version) as unknown as RequestView['files'] : [],
      ...(party ? { amount: row.amount, paymentMethod: payment.method, paymentState: payment.state } : {}),
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
    const rows = this.store.db.prepare('SELECT * FROM requests WHERE client_id = ? OR creator_id = ? ORDER BY created_at DESC, rowid DESC').all(actor, actor) as unknown as RequestRow[];
    return rows.map((row) => this.view(row, actor));
  }
  publicWorks(): RequestView[] {
    const rows = this.store.db.prepare("SELECT * FROM requests WHERE state = 'delivered' AND visibility != 'hidden' AND nsfw = 0 ORDER BY created_at DESC").all() as unknown as RequestRow[];
    return rows.map((row) => this.view(row));
  }
  private command(actor: string, scope: string, key: string, payload: unknown, run: () => string): RequestView {
    this.user(actor);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) fail('BAD_KEY', '操作を再読み込みしてお試しください。', 400);
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const id = this.store.transaction(() => {
      const existing = this.one<{ fingerprint: string; request_id: string }>('SELECT * FROM commands WHERE actor_id = ? AND scope = ? AND key = ?', actor, scope, key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('KEY_REUSED', '同じ操作キーで内容を変更することはできません。');
        return existing.request_id;
      }
      const result = run();
      this.store.db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(actor, scope, key, fingerprint, result);
      return result;
    });
    return this.get(actor, id);
  }
  create(actor: string, key: string, input: RequestInput): RequestView {
    this.expire();
    if (!input || typeof input !== 'object') fail('INVALID_INPUT', '依頼内容を入力してください。', 400);
    if (typeof input.genre !== 'string' || !Object.hasOwn(genres, input.genre) || !['public', 'anonymous', 'hidden'].includes(input.visibility) || !['card', 'points'].includes(input.paymentMethod)) fail('INVALID_INPUT', '依頼の設定を確認してください。', 400);
    if (typeof input.brief !== 'string' || !input.brief.trim() || input.brief.trim().length > this.policy.maximumBriefLength) fail('INVALID_BRIEF', `依頼内容は1〜${this.policy.maximumBriefLength}文字で入力してください。`, 400);
    if (!Number.isSafeInteger(input.amount) || input.amount < this.policy.minimumAmount || input.amount > this.policy.maximumAmount) fail('INVALID_AMOUNT', '依頼金額を確認してください。', 400);
    if (input.agreeToRules !== true || typeof input.nsfw !== 'boolean') fail('RULES_REQUIRED', '依頼のルールへの同意が必要です。', 400);
    const normalized = { ...input, brief: input.brief.trim() };
    return this.command(actor, 'create', key, normalized, () => {
      if (this.user(actor).role !== 'client' || this.user(input.creatorId).role !== 'creator' || actor === input.creatorId) fail('FORBIDDEN', 'この相手には依頼できません。', 403);
      if (this.mock.failAuthorization) fail('PAYMENT_DECLINED', '支払いを確保できませんでした。別の支払方法をお試しください。', 422);
      if (input.paymentMethod === 'points' && this.availablePoints(actor) < input.amount) fail('INSUFFICIENT_POINTS', '利用できるポイントが不足しています。', 422);
      const id = randomUUID();
      const now = this.clock();
      this.store.db.prepare(`INSERT INTO requests (id, client_id, creator_id, genre, brief, amount, visibility, nsfw, state, created_at, accept_by, deliver_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_acceptance', ?, ?, ?)`).run(id, actor, input.creatorId, input.genre, normalized.brief, input.amount, input.visibility, Number(input.nsfw), now, now + this.policy.acceptanceMs, now + this.policy.deliveryMs);
      this.store.db.prepare("INSERT INTO payments VALUES (?, ?, 'authorized', ?, ?, 0)").run(id, input.paymentMethod, input.amount, now + this.policy.authorizationMs);
      this.effect(id, 'authorize');
      this.audit(id, actor, 'submit');
      return id;
    });
  }
  accept(actor: string, id: string, key: string): RequestView {
    this.expire();
    return this.command(actor, `accept:${id}`, key, {}, () => {
      const row = this.row(id);
      this.participant(actor, row);
      if (actor !== row.creator_id) fail('FORBIDDEN', '承認できるのは依頼先の作り手だけです。', 403);
      if (row.state !== 'awaiting_acceptance') fail('INVALID_STATE', 'この依頼は承認できません。');
      if (this.mock.failCapture) fail('PAYMENT_DECLINED', '支払いを確定できませんでした。制作はまだ始めないでください。', 422);
      this.store.db.prepare("UPDATE requests SET state = 'accepting' WHERE id = ?").run(id);
      this.store.db.prepare('UPDATE payments SET capture_requested = 1 WHERE request_id = ?').run(id);
      this.audit(id, actor, 'accept');
      if (!this.mock.deferCardCapture || this.payment(id).method === 'points') this.capture(id);
      return id;
    });
  }
  private capture(id: string) {
    const row = this.row(id);
    const payment = this.payment(id);
    if (!payment.capture_requested) fail('UNEXPECTED_CAPTURE', '承認されていない支払いです。');
    if (!this.effect(id, 'capture')) return;
    if (payment.method === 'points') {
      if (payment.state !== 'authorized') fail('INVALID_PAYMENT', 'ポイントの確保が解除されています。');
      this.store.db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(payment.amount, row.client_id);
    }
    this.store.db.prepare("UPDATE payments SET state = 'captured' WHERE request_id = ?").run(id);
    if (row.state === 'cancelled' || this.clock() >= Math.min(row.accept_by, row.deliver_by, payment.hold_until)) {
      this.cancelInternal(id, 'payment_expired', 'system');
    } else {
      this.store.db.prepare("UPDATE requests SET state = 'accepted' WHERE id = ?").run(id);
    }
  }
  /** Trusted mock-provider event entrypoint, deliberately not an HTTP route. */
  completeMockCapture(id: string, eventId: string): void {
    this.expire();
    this.store.transaction(() => {
      const prior = this.one<{ request_id: string }>('SELECT request_id FROM payment_events WHERE id = ?', eventId);
      if (prior) {
        if (prior.request_id !== id) fail('EVENT_REUSED', '決済通知の識別子が重複しています。');
        return;
      }
      this.capture(id);
      this.store.db.prepare('INSERT INTO payment_events VALUES (?, ?)').run(eventId, id);
    });
  }
  private cancelInternal(id: string, reason: string, actor: string) {
    const row = this.row(id);
    const payment = this.payment(id);
    if (payment.state === 'authorized') {
      this.effect(id, 'release');
      this.store.db.prepare("UPDATE payments SET state = 'released' WHERE request_id = ?").run(id);
    } else if (payment.state === 'captured') {
      if (this.effect(id, 'refund') && payment.method === 'points') this.store.db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(payment.amount, row.client_id);
      this.store.db.prepare("UPDATE payments SET state = 'refunded' WHERE request_id = ?").run(id);
    }
    if (row.state !== 'cancelled') {
      this.store.db.prepare("UPDATE requests SET state = 'cancelled', cancelled_reason = ? WHERE id = ?").run(reason, id);
      this.audit(id, actor, reason);
    }
  }
  cancel(actor: string, id: string, key: string): RequestView {
    this.expire();
    return this.command(actor, `cancel:${id}`, key, {}, () => {
      const row = this.row(id);
      this.participant(actor, row);
      if (row.state === 'cancelled') return id;
      if (row.state === 'accepted' && actor === row.creator_id) this.cancelInternal(id, 'give_up', actor);
      else if (row.state === 'awaiting_acceptance') this.cancelInternal(id, actor === row.client_id ? 'withdrawn' : 'declined', actor);
      else fail('INVALID_STATE', 'この依頼は取り消せません。');
      return id;
    });
  }
  expire(): number {
    return this.store.transaction(() => {
      const now = this.clock();
      const rows = this.store.db.prepare(`SELECT r.* FROM requests r JOIN payments p ON r.id = p.request_id
        WHERE (r.state IN ('awaiting_acceptance', 'accepting') AND (r.accept_by <= ? OR p.hold_until <= ? OR r.deliver_by <= ?))
        OR (r.state = 'accepted' AND r.deliver_by <= ?)`).all(now, now, now, now) as unknown as RequestRow[];
      for (const row of rows) this.cancelInternal(row.id, row.state === 'accepted' ? 'delivery_expired' : 'acceptance_expired', 'system');
      return rows.length;
    });
  }
  deliver(actor: string, id: string, key: string, files: UploadInput[]): RequestView {
    this.expire();
    if (!Array.isArray(files) || files.length < 1 || files.length > this.policy.maximumFiles) fail('INVALID_FILES', `納品ファイルは1〜${this.policy.maximumFiles}個で選んでください。`, 400);
    let total = 0;
    const buffers = files.map((file) => {
      if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(file.name)) fail('INVALID_FILE_NAME', 'ファイル名を確認してください。', 400);
      if (typeof file.content !== 'string' || file.content.length > Math.ceil(this.policy.maximumUploadBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) fail('INVALID_FILE', 'ファイルを読み取れませんでした。', 400);
      const buffer = Buffer.from(file.content, 'base64');
      if (buffer.toString('base64') !== file.content) fail('INVALID_FILE', 'ファイルを読み取れませんでした。', 400);
      total += buffer.length;
      if (!buffer.length || total > this.policy.maximumUploadBytes) fail('FILE_TOO_LARGE', 'ファイルは合計8 MB以内で選んでください。', 400);
      return buffer;
    });
    return this.command(actor, `deliver:${id}`, key, files, () => {
      const row = this.row(id);
      this.participant(actor, row);
      if (actor !== row.creator_id) fail('FORBIDDEN', '納品できるのは依頼先の作り手だけです。', 403);
      if (!['accepted', 'delivered'].includes(row.state) || this.clock() >= row.deliver_by) fail('INVALID_STATE', 'この依頼には納品できません。');
      if (this.payment(id).state !== 'captured') fail('INVALID_PAYMENT', '支払確認が完了していません。');
      const version = row.delivery_version + 1;
      files.forEach((file, index) => this.store.db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, version, file.name, buffers[index]!));
      this.store.db.prepare("UPDATE requests SET state = 'delivered', delivery_version = ? WHERE id = ?").run(version, id);
      this.effect(id, 'sale');
      this.audit(id, actor, version === 1 ? 'deliver' : 'redeliver');
      return id;
    });
  }
  download(actor: string, fileId: string): FileRow {
    this.user(actor);
    const file = this.one<FileRow>('SELECT id, request_id, name, data FROM files WHERE id = ?', fileId) ?? fail('NOT_FOUND', 'ファイルが見つかりません。', 404);
    this.participant(actor, this.row(file.request_id));
    return file;
  }
}
