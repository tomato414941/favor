import { randomUUID } from 'node:crypto';
import type {
  LinkDelivery,
  RequestLinkInput,
  RequestLinkResult,
  RequestLinkState,
  RequestLinkView,
  SocialAccount,
  Visibility,
} from '../shared.js';
import { AuthService, hashToken, isToken, newToken } from './auth.js';
import { commandFingerprint } from './fingerprint.js';
import { isValidEmail, normalizeEmail, type EmailDelivery } from './email-delivery.js';
import { RequestService, DomainError } from './service.js';

const DAY = 86_400_000;
const POLICY = { maximumPending: 5, maximumPerDay: 10, maximumReissuesPerHour: 5 };
interface LinkRow {
  id: string;
  client_id: string;
  recipient_provider: string;
  recipient_subject: string;
  recipient_name: string;
  delivery: LinkDelivery;
  recipient_email: string | null;
  brief: string;
  amount: number;
  visibility: Visibility;
  state: RequestLinkState;
  created_at: number;
  expires_at: number;
  deliver_by: number;
  token_hash: string;
  cancelled_reason: string | null;
  request_id: string | null;
}
const unavailable = (): never => {
  throw new DomainError(
    'LINK_UNAVAILABLE',
    'この依頼リンクは利用できません。リンクを送った方にご確認ください。',
    404,
  );
};
const socialActor = (account: SocialAccount) => JSON.stringify([account.provider, account.subject]);
const mailUnavailable = () =>
  new DomainError(
    'EMAIL_UNAVAILABLE',
    'メールを送信できませんでした。時間をおいてお試しください。',
    503,
  );
const formatDate = (value: number) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);

export class RequestLinkService {
  private readonly store;
  private readonly clock;
  constructor(
    private readonly requests: RequestService,
    private readonly auth: AuthService,
    private readonly mail?: EmailDelivery,
  ) {
    this.store = requests.store;
    this.clock = requests.clock;
  }
  private row(id: string): LinkRow {
    return (
      (this.store.db.prepare('SELECT * FROM request_links WHERE id = ?').get(id) as unknown as
        LinkRow | undefined) ?? unavailable()
    );
  }
  private owner(actor: string, id: string): LinkRow {
    const row = this.row(id);
    if (row.client_id !== actor) unavailable();
    return row;
  }
  private byToken(token: string): LinkRow {
    if (!isToken(token)) unavailable();
    return (
      (this.store.db
        .prepare('SELECT * FROM request_links WHERE token_hash = ?')
        .get(hashToken(token)) as unknown as LinkRow | undefined) ?? unavailable()
    );
  }
  /** Links mailed by the service open only for the addressed mailbox. */
  private addressed(row: LinkRow, account?: SocialAccount, email?: string) {
    if (row.delivery !== 'email') return;
    if (!account)
      throw new DomainError(
        'LINK_LOGIN_REQUIRED',
        'この依頼は、宛先のメールアドレスでログインすると開けます。',
        401,
      );
    if (normalizeEmail(email ?? '') !== row.recipient_email)
      throw new DomainError('LINK_OTHER_RECIPIENT', 'この依頼は別のメールアドレス宛です。', 403);
  }
  private accessible(token: string, account?: SocialAccount, email?: string): LinkRow {
    const row = this.byToken(token);
    if (row.state === 'cancelled') unavailable();
    this.addressed(row, account, email);
    if (
      row.state === 'accepted' &&
      (!account ||
        row.recipient_provider !== account.provider ||
        row.recipient_subject !== account.subject)
    )
      unavailable();
    return row;
  }
  private pending(row: LinkRow) {
    if (row.state !== 'pending' || this.clock() >= row.expires_at)
      throw new DomainError('LINK_CLOSED', 'この依頼の受付は終了しました。');
  }
  private event(id: string, actor: string, action: string) {
    this.store.db
      .prepare('INSERT INTO link_events (link_id, actor_id, action, at) VALUES (?, ?, ?, ?)')
      .run(id, actor, action, this.clock());
  }
  private view(row: LinkRow, sender: boolean): RequestLinkView {
    const client = this.requests.session(row.client_id);
    const request = row.request_id ? this.requests.get(row.client_id, row.request_id) : null;
    return {
      id: row.id,
      delivery: row.delivery,
      recipientEmail: sender ? row.recipient_email : null,
      recipientName: row.recipient_name,
      clientName: !sender && row.visibility === 'anonymous' ? '匿名の依頼者' : client.name,
      brief: row.brief,
      amount: row.amount,
      visibility: row.visibility,
      state: row.state,
      paymentState: request?.paymentState ?? (row.state === 'pending' ? 'authorized' : 'released'),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deliverBy: row.deliver_by,
      cancelledReason: row.cancelled_reason,
      requestId: row.request_id,
    };
  }
  private command(
    actor: string,
    scope: string,
    key: string,
    payload: unknown,
    run: () => { id: string; token?: string },
  ) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new DomainError('BAD_KEY', '操作を再読み込みしてお試しください。', 400);
    const fingerprint = commandFingerprint(payload);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT * FROM link_commands WHERE actor_id = ? AND scope = ? AND key = ?')
        .get(actor, scope, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError('KEY_REUSED', '同じ操作キーで内容を変更することはできません。');
        return { id: String(prior.link_id) };
      }
      const result = run();
      this.store.db
        .prepare('INSERT INTO link_commands VALUES (?, ?, ?, ?, ?)')
        .run(actor, scope, key, fingerprint, result.id);
      return result;
    });
  }
  list(actor: string): RequestLinkView[] {
    this.requests.session(actor);
    this.expire();
    const rows = this.store.db
      .prepare(
        'SELECT * FROM request_links WHERE client_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(actor) as unknown as LinkRow[];
    return rows.map((row) => this.view(row, true));
  }
  read(token: string, account?: SocialAccount, email?: string): RequestLinkView {
    this.expire();
    return this.store.transaction(() => this.view(this.accessible(token, account, email), false));
  }
  get(actor: string, id: string): RequestLinkView {
    return this.view(this.owner(actor, id), true);
  }
  create(actor: string, key: string, input: RequestLinkInput): RequestLinkResult {
    this.requests.session(actor);
    this.expire();
    const policy = this.requests.policy;
    if (
      !input ||
      typeof input.brief !== 'string' ||
      !input.brief.trim() ||
      input.brief.trim().length > policy.maximumBriefLength ||
      !Number.isSafeInteger(input.amount) ||
      input.amount < policy.minimumAmount ||
      input.amount > policy.maximumAmount ||
      !['public', 'anonymous', 'hidden'].includes(input.visibility) ||
      input.agreeToRules !== true ||
      !['self', 'email', undefined].includes(input.delivery)
    ) {
      throw new DomainError(
        'INVALID_INPUT',
        '依頼内容・金額・ルールへの同意を確認してください。',
        400,
      );
    }
    const delivery: LinkDelivery = input.delivery ?? 'self';
    const recipientEmail = delivery === 'email' ? normalizeEmail(input.recipientEmail ?? '') : null;
    if (delivery === 'email' && !isValidEmail(recipientEmail!))
      throw new DomainError('INVALID_EMAIL', '相手のメールアドレスを正しく入力してください。', 400);
    if (input.visibility === 'anonymous' && delivery !== 'email')
      throw new DomainError('INVALID_INPUT', '匿名の依頼は、メールで送る場合にだけ選べます。', 400);
    const normalized = {
      brief: input.brief.trim(),
      amount: input.amount,
      visibility: input.visibility,
      agreeToRules: true,
      delivery,
      recipientEmail,
    };
    const result = this.command(`user:${actor}`, 'create', key, normalized, () => {
      const now = this.clock();
      const counts = this.store.db
        .prepare(
          `SELECT
        COUNT(*) FILTER (WHERE state = 'pending') AS pending,
        COUNT(*) FILTER (WHERE created_at > ?) AS today
        FROM request_links WHERE client_id = ?`,
        )
        .get(now - DAY, actor)!;
      if (
        Number(counts.pending) >= POLICY.maximumPending ||
        Number(counts.today) >= POLICY.maximumPerDay
      ) {
        throw new DomainError(
          'LINK_LIMIT',
          '依頼の作成件数が上限に達しています。時間をおいてお試しください。',
          429,
        );
      }
      if (recipientEmail) {
        if (this.optout(recipientEmail).blocked)
          throw new DomainError('RECIPIENT_UNAVAILABLE', 'この宛先には送れません。', 409);
        const duplicate = this.store.db
          .prepare(
            "SELECT 1 FROM request_links WHERE client_id = ? AND recipient_email = ? AND state = 'pending'",
          )
          .get(actor, recipientEmail);
        if (duplicate)
          throw new DomainError('DUPLICATE_LINK', 'この宛先には受諾待ちの依頼があります。', 409);
      }
      if (this.requests.mock.failAuthorization)
        throw new DomainError('PAYMENT_DECLINED', '支払いを確保できませんでした。', 422);
      const id = randomUUID();
      const token = newToken();
      const expiresAt =
        now + Math.min(policy.acceptanceMs, policy.authorizationMs, policy.deliveryMs);
      this.store.db
        .prepare(
          `INSERT INTO request_links (id, client_id, recipient_provider, recipient_subject, recipient_name,
        delivery, recipient_email, brief, amount, visibility, state, created_at, expires_at, deliver_by, token_hash)
        VALUES (?, ?, '', '', '', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          id,
          actor,
          delivery,
          recipientEmail,
          normalized.brief,
          input.amount,
          input.visibility,
          now,
          expiresAt,
          now + policy.deliveryMs,
          hashToken(token),
        );
      this.event(id, `user:${actor}`, 'authorize');
      return { id, token };
    });
    return {
      link: this.view(this.owner(actor, result.id), true),
      ...('token' in result ? { token: result.token } : {}),
    };
  }
  reissue(actor: string, id: string, key: string): RequestLinkResult {
    this.requests.session(actor);
    this.expire();
    return this.store.transaction(() => {
      this.pending(this.owner(actor, id));
      const result = this.command(`user:${actor}`, `reissue:${id}`, key, {}, () => {
        const count = this.store.db
          .prepare(
            "SELECT COUNT(*) AS total FROM link_events WHERE link_id = ? AND action = 'reissue' AND at > ?",
          )
          .get(id, this.clock() - 3_600_000)!;
        if (Number(count.total) >= POLICY.maximumReissuesPerHour)
          throw new DomainError(
            'REISSUE_LIMIT',
            'リンクの再発行は時間をおいてお試しください。',
            429,
          );
        const token = newToken();
        this.store.db
          .prepare('UPDATE request_links SET token_hash = ? WHERE id = ?')
          .run(hashToken(token), id);
        this.event(id, `user:${actor}`, 'reissue');
        return { id, token };
      });
      return {
        link: this.view(this.owner(actor, id), true),
        ...('token' in result ? { token: result.token } : {}),
      };
    });
  }
  private cancel(row: LinkRow, reason: string, actor: string) {
    const updated = this.store.db
      .prepare(
        "UPDATE request_links SET state = 'cancelled', cancelled_reason = ? WHERE id = ? AND state = 'pending'",
      )
      .run(reason, row.id);
    if (Number(updated.changes) === 1) this.event(row.id, actor, 'release');
  }
  withdraw(actor: string, id: string, key: string): RequestLinkView {
    this.requests.session(actor);
    this.expire();
    this.owner(actor, id);
    this.command(`user:${actor}`, `withdraw:${id}`, key, {}, () => {
      const row = this.owner(actor, id);
      if (row.state === 'accepted')
        throw new DomainError('LINK_CLOSED', '受諾済みの依頼は、依頼一覧で確認してください。');
      this.cancel(row, 'withdrawn', `user:${actor}`);
      return { id };
    });
    return this.view(this.row(id), true);
  }
  decline(token: string, key: string, account?: SocialAccount, email?: string): { ok: true } {
    this.expire();
    return this.store.transaction(() => {
      const row = this.byToken(token);
      if (row.state !== 'pending' && row.cancelled_reason !== 'declined') unavailable();
      this.addressed(row, account, email);
      this.command(`link:${hashToken(token)}`, `decline:${row.id}`, key, {}, () => {
        this.pending(row);
        this.cancel(row, 'declined', 'link-recipient');
        return { id: row.id };
      });
      return { ok: true };
    });
  }
  accept(
    account: SocialAccount,
    token: string,
    key: string,
    agreed: boolean,
    email?: string,
  ): RequestLinkView {
    this.expire();
    return this.store.transaction(() => {
      const row = this.accessible(token, account, email);
      if (agreed !== true)
        throw new DomainError('RULES_REQUIRED', '依頼のルールへの同意が必要です。', 400);
      this.command(socialActor(account), `accept:${row.id}`, key, { agreed: true }, () => {
        this.pending(row);
        const actor = this.auth.registerRecipient(account);
        const request = this.requests.receiveLink(
          actor,
          row.client_id,
          {
            brief: row.brief,
            amount: row.amount,
            visibility: row.visibility,
            agreeToRules: true,
          },
          { createdAt: row.created_at, expiresAt: row.expires_at, deliverBy: row.deliver_by },
        );
        this.store.db
          .prepare(
            "UPDATE request_links SET state = 'accepted', request_id = ?, recipient_provider = ?, recipient_subject = ?, recipient_name = ? WHERE id = ?",
          )
          .run(request.id, account.provider, account.subject, account.name, row.id);
        this.event(row.id, socialActor(account), 'accept');
        return { id: row.id };
      });
      return this.view(this.row(row.id), false);
    });
  }
  /** Mails the link to its recipient. A failed first delivery releases the hold so no money stays held for an unreachable address. */
  async send(actor: string, id: string, token: string, origin: string, first: boolean) {
    const row = this.owner(actor, id);
    if (row.delivery !== 'email' || !row.recipient_email) return;
    if (!this.mail) throw mailUnavailable();
    const client = this.requests.session(row.client_id);
    const from = row.visibility === 'anonymous' ? '匿名の依頼者' : client.name;
    try {
      await this.mail({
        to: row.recipient_email,
        subject: 'Favor 制作の依頼が届いています',
        text: `${from}から制作の依頼が届いています。\n\n内容と金額は次のリンクで確認できます。受けるかどうかは自由に選べます。\n${origin}/link#${token}\n\n受諾期限：${formatDate(row.expires_at)}\n\nこのリンクは、宛先のメールアドレスでログインすると開けます。\n心当たりがない場合は、このメールを破棄してください。今後メールで依頼を受け取らない設定は、リンク先で行えます。`,
      });
    } catch {
      if (first) this.store.transaction(() => this.cancel(this.row(id), 'undeliverable', 'system'));
      throw mailUnavailable();
    }
    this.event(id, 'system', first ? 'mail' : 'remail');
  }
  optout(email: string): { blocked: boolean } {
    const row = this.store.db
      .prepare('SELECT 1 FROM link_optouts WHERE email = ?')
      .get(normalizeEmail(email));
    return { blocked: Boolean(row) };
  }
  setOptout(email: string, blocked: boolean): { blocked: boolean } {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized))
      throw new DomainError('INVALID_EMAIL', 'メールアドレスを確認してください。', 400);
    return this.store.transaction(() => {
      if (!blocked) {
        this.store.db.prepare('DELETE FROM link_optouts WHERE email = ?').run(normalized);
        return { blocked: false };
      }
      this.store.db
        .prepare('INSERT OR IGNORE INTO link_optouts VALUES (?, ?)')
        .run(normalized, this.clock());
      const rows = this.store.db
        .prepare(
          "SELECT * FROM request_links WHERE delivery = 'email' AND recipient_email = ? AND state = 'pending'",
        )
        .all(normalized) as unknown as LinkRow[];
      for (const row of rows) this.cancel(row, 'recipient_blocked', 'link-recipient');
      return { blocked: true };
    });
  }
  expire(): number {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare("SELECT * FROM request_links WHERE state = 'pending' AND expires_at <= ?")
        .all(this.clock()) as unknown as LinkRow[];
      for (const row of rows) this.cancel(row, 'expired', 'system');
      return rows.length;
    });
  }
}
