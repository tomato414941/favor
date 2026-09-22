import { randomUUID } from 'node:crypto';
import type { InvitationInput, InvitationLinkResult, InvitationState, InvitationView, RequestLinkInput, SocialAccount, Visibility } from '../shared.js';
import { AuthService, hashToken, isToken, newToken } from './auth.js';
import { commandFingerprint } from './fingerprint.js';
import { CommissionService, DomainError } from './service.js';

const DAY = 86_400_000;
export const INVITATION_POLICY = { maximumPending: 5, maximumPerDay: 10, recipientCooldownMs: DAY, maximumReissuesPerHour: 5 };
interface InvitationRow {
  id: string; client_id: string; recipient_provider: string; recipient_subject: string;
  recipient_handle: string; recipient_name: string; brief: string; amount: number;
  visibility: Visibility; nsfw: number; state: InvitationState; created_at: number;
  expires_at: number; deliver_by: number; token_hash: string; cancelled_reason: string | null;
  request_id: string | null;
  access_mode: 'account' | 'link';
}
const unavailable = (): never => { throw new DomainError('INVITATION_UNAVAILABLE', 'この招待を確認できません。宛先のアカウントとリンクをお確かめください。', 404); };
const socialActor = (account: SocialAccount) => JSON.stringify([account.provider, account.subject]);

export class InvitationService {
  readonly store;
  readonly clock;
  constructor(readonly commissions: CommissionService, readonly auth: AuthService) {
    this.store = commissions.store;
    this.clock = commissions.clock;
  }
  private row(id: string): InvitationRow {
    return this.store.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as unknown as InvitationRow | undefined ?? unavailable();
  }
  private owner(actor: string, id: string): InvitationRow {
    const row = this.row(id);
    if (row.client_id !== actor) unavailable();
    return row;
  }
  private recipient(account: SocialAccount, token: string): InvitationRow {
    if (!isToken(token)) unavailable();
    const row = this.store.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(hashToken(token)) as unknown as InvitationRow | undefined;
    if (!row || row.access_mode !== 'account' || row.recipient_provider !== account.provider || row.recipient_subject !== account.subject
      || row.cancelled_reason === 'expired' || row.cancelled_reason === 'withdrawn') return unavailable();
    return row;
  }
  private event(id: string, actor: string, action: string) {
    this.store.db.prepare('INSERT INTO invitation_events (invitation_id, actor_id, action, at) VALUES (?, ?, ?, ?)').run(id, actor, action, this.clock());
  }
  private pending(row: InvitationRow) {
    if (row.state !== 'pending' || this.clock() >= row.expires_at) throw new DomainError('INVITATION_CLOSED', 'この招待の受付は終了しました。');
  }
  private view(row: InvitationRow, sender: boolean): InvitationView {
    const client = this.store.db.prepare('SELECT name FROM users WHERE id = ?').get(row.client_id)!;
    const request = row.request_id ? this.commissions.get(row.client_id, row.request_id) : null;
    return {
      id: row.id, recipientName: row.recipient_name, recipientHandle: row.recipient_handle,
      clientName: !sender && row.visibility === 'anonymous' ? '匿名の依頼者' : String(client.name),
      brief: row.brief, amount: row.amount, visibility: row.visibility, nsfw: Boolean(row.nsfw), state: row.state,
      paymentState: request?.paymentState ?? (row.state === 'pending' ? 'authorized' : 'released'),
      createdAt: row.created_at, expiresAt: row.expires_at, deliverBy: row.deliver_by,
      cancelledReason: row.cancelled_reason, requestId: row.request_id,
    };
  }
  private command(actor: string, scope: string, key: string, payload: unknown, run: () => { id: string; token?: string }) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new DomainError('BAD_KEY', '操作を再読み込みしてお試しください。', 400);
    const fingerprint = commandFingerprint(payload);
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT * FROM invitation_commands WHERE actor_id = ? AND scope = ? AND key = ?').get(actor, scope, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new DomainError('KEY_REUSED', '同じ操作キーで内容を変更することはできません。');
        return { id: String(prior.invitation_id) };
      }
      const result = run();
      this.store.db.prepare('INSERT INTO invitation_commands VALUES (?, ?, ?, ?, ?)').run(actor, scope, key, fingerprint, result.id);
      return result;
    });
  }
  list(actor: string): InvitationView[] {
    this.commissions.session(actor);
    this.expire();
    const rows = this.store.db.prepare("SELECT * FROM invitations WHERE client_id = ? AND access_mode = 'account' ORDER BY created_at DESC, rowid DESC").all(actor) as unknown as InvitationRow[];
    return rows.map((row) => this.view(row, true));
  }
  read(account: SocialAccount, token: string): InvitationView {
    this.expire();
    return this.store.transaction(() => this.view(this.recipient(account, token), false));
  }
  listLinks(actor: string): InvitationView[] {
    this.commissions.session(actor);
    this.expire();
    const rows = this.store.db.prepare("SELECT * FROM invitations WHERE client_id = ? AND access_mode = 'link' ORDER BY created_at DESC, rowid DESC").all(actor) as unknown as InvitationRow[];
    return rows.map((row) => this.view(row, true));
  }
  private link(token: string, account?: SocialAccount): InvitationRow {
    const missing = () => new DomainError('LINK_UNAVAILABLE', 'この依頼リンクは利用できません。リンクを送った方にご確認ください。', 404);
    if (!isToken(token)) throw missing();
    const row = this.store.db.prepare("SELECT * FROM invitations WHERE token_hash = ? AND access_mode = 'link'").get(hashToken(token)) as unknown as InvitationRow | undefined;
    if (!row || row.state === 'cancelled') throw missing();
    if (row.state === 'accepted' && (!account || row.recipient_provider !== account.provider || row.recipient_subject !== account.subject)) throw missing();
    return row;
  }
  readLink(token: string, account?: SocialAccount): InvitationView {
    this.expire();
    return this.store.transaction(() => this.view(this.link(token, account), false));
  }
  createLink(actor: string, key: string, input: RequestLinkInput): InvitationLinkResult {
    return this.createFor(actor, key, input);
  }
  reissueLink(actor: string, id: string, key: string): InvitationLinkResult {
    if (this.owner(actor, id).access_mode !== 'link') unavailable();
    return this.reissue(actor, id, key);
  }
  withdrawLink(actor: string, id: string, key: string): InvitationView {
    if (this.owner(actor, id).access_mode !== 'link') unavailable();
    return this.withdraw(actor, id, key);
  }
  declineLink(token: string, key: string): { ok: true } {
    this.expire();
    return this.store.transaction(() => {
      // A repeated decline succeeds without reopening the private contents.
      if (!isToken(token)) this.link(token);
      const row = this.store.db.prepare("SELECT * FROM invitations WHERE token_hash = ? AND access_mode = 'link'").get(hashToken(token)) as unknown as InvitationRow | undefined;
      if (!row || (row.state !== 'pending' && row.cancelled_reason !== 'declined')) this.link(token);
      this.command(`link:${hashToken(token)}`, `decline:${row!.id}`, key, {}, () => {
        this.pending(row!);
        this.cancelInternal(row!, 'declined', 'link-recipient');
        return { id: row!.id };
      });
      return { ok: true };
    });
  }
  acceptLink(account: SocialAccount, token: string, key: string, agreed: boolean): InvitationView {
    this.expire();
    return this.store.transaction(() => {
      const row = this.link(token, account);
      if (agreed !== true) throw new DomainError('RULES_REQUIRED', '依頼のルールへの同意が必要です。', 400);
      this.command(socialActor(account), `accept:${row.id}`, key, { agreed: true }, () => {
        this.pending(row);
        const actor = this.auth.registerRecipient(account);
        const request = this.commissions.receiveInvitation(actor, row.client_id, {
          brief: row.brief, amount: row.amount, visibility: row.visibility, nsfw: Boolean(row.nsfw), agreeToRules: true,
        }, { createdAt: row.created_at, expiresAt: row.expires_at, deliverBy: row.deliver_by }, key);
        this.store.db.prepare("UPDATE invitations SET state = 'accepted', request_id = ?, recipient_provider = ?, recipient_subject = ?, recipient_handle = ?, recipient_name = ? WHERE id = ?").run(
          request.id, account.provider, account.subject, '', account.name, row.id);
        this.event(row.id, socialActor(account), 'accept');
        return { id: row.id };
      });
      return this.view(this.row(row.id), false);
    });
  }
  /** recipient must come from a server-side provider lookup, never from a claimed browser ID. */
  async createWithLookup(actor: string, key: string, input: InvitationInput, lookup: () => Promise<SocialAccount>): Promise<InvitationLinkResult> {
    this.commissions.session(actor);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new DomainError('BAD_KEY', '操作を再読み込みしてお試しください。', 400);
    const fingerprint = commandFingerprint({ ...input, brief: input.brief.trim() });
    const prior = () => {
      const row = this.store.db.prepare('SELECT * FROM invitation_submissions WHERE actor_id = ? AND key = ?').get(actor, key);
      if (!row) return null;
      if (row.fingerprint !== fingerprint) throw new DomainError('KEY_REUSED', '同じ操作キーで内容を変更することはできません。');
      this.expire();
      return { invitation: this.view(this.owner(actor, String(row.invitation_id)), true) };
    };
    const existing = prior();
    if (existing) return existing;
    const recipient = await lookup();
    return this.store.transaction(() => {
      const concurrent = prior();
      if (concurrent) return concurrent;
      const result = this.create(actor, key, input, recipient);
      this.store.db.prepare('INSERT INTO invitation_submissions VALUES (?, ?, ?, ?)').run(actor, key, fingerprint, result.invitation.id);
      return result;
    });
  }
  create(actor: string, key: string, input: InvitationInput, recipient: SocialAccount): InvitationLinkResult {
    return this.createFor(actor, key, input, recipient);
  }
  private createFor(actor: string, key: string, input: RequestLinkInput, recipient?: SocialAccount): InvitationLinkResult {
    this.commissions.session(actor);
    this.expire();
    const policy = this.commissions.policy;
    if (!input || typeof input.brief !== 'string' || !input.brief.trim() || input.brief.trim().length > policy.maximumBriefLength
      || !Number.isSafeInteger(input.amount) || input.amount < policy.minimumAmount || input.amount > policy.maximumAmount
      || !['public', 'anonymous', 'hidden'].includes(input.visibility) || typeof input.nsfw !== 'boolean' || input.agreeToRules !== true) {
      throw new DomainError('INVALID_INPUT', '依頼内容・金額・ルールへの同意を確認してください。', 400);
    }
    const normalized = { brief: input.brief.trim(), amount: input.amount, visibility: input.visibility,
      nsfw: input.nsfw, agreeToRules: true, ...(recipient ? { provider: recipient.provider, subject: recipient.subject } : { access: 'link' }) };
    const result = this.command(`user:${actor}`, 'create', key, normalized, () => {
      const ownAccount = recipient && this.store.db.prepare('SELECT user_id FROM social_accounts WHERE provider = ? AND subject = ?').get(recipient.provider, recipient.subject);
      if (ownAccount?.user_id === actor) throw new DomainError('FORBIDDEN', '自分自身には招待を送れません。', 403);
      if (recipient && this.preference(recipient).blocked) throw new DomainError('INVITATIONS_DISABLED', 'この相手は招待を受け付けていません。', 409);
      const now = this.clock();
      const count = (sql: string, ...params: Array<string | number>) => Number(this.store.db.prepare(sql).get(...params)!.total);
      if (count("SELECT COUNT(*) AS total FROM invitations WHERE client_id = ? AND state = 'pending'", actor) >= INVITATION_POLICY.maximumPending
        || count('SELECT COUNT(*) AS total FROM invitations WHERE client_id = ? AND created_at > ?', actor, now - DAY) >= INVITATION_POLICY.maximumPerDay) {
        throw new DomainError('INVITATION_LIMIT', '依頼の作成件数が上限に達しています。時間をおいてお試しください。', 429);
      }
      if (recipient && count(`SELECT COUNT(*) AS total FROM invitations WHERE client_id = ? AND recipient_provider = ? AND recipient_subject = ?
        AND (state = 'pending' OR created_at > ?)`, actor, recipient.provider, recipient.subject, now - INVITATION_POLICY.recipientCooldownMs)) {
        throw new DomainError('DUPLICATE_INVITATION', 'この相手にはすでに招待を作成しています。新しい招待は24時間後から作成できます。');
      }
      if (this.commissions.mock.failAuthorization) throw new DomainError('PAYMENT_DECLINED', '支払いを確保できませんでした。', 422);
      const id = randomUUID();
      const token = newToken();
      const expiresAt = now + Math.min(policy.acceptanceMs, policy.authorizationMs, policy.deliveryMs);
      this.store.db.prepare(`INSERT INTO invitations (id, client_id, recipient_provider, recipient_subject, recipient_handle, recipient_name,
        brief, amount, visibility, nsfw, state, created_at, expires_at, deliver_by, token_hash, access_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`).run(id, actor, recipient?.provider ?? '', recipient?.subject ?? '',
          recipient?.handle ?? '', recipient?.name ?? '', normalized.brief, input.amount, input.visibility, Number(input.nsfw), now, expiresAt, now + policy.deliveryMs, hashToken(token), recipient ? 'account' : 'link');
      this.event(id, `user:${actor}`, 'authorize');
      return { id, token };
    });
    return { invitation: this.view(this.owner(actor, result.id), true), ...('token' in result ? { token: result.token } : {}) };
  }
  reissue(actor: string, id: string, key: string): InvitationLinkResult {
    this.commissions.session(actor);
    this.expire();
    return this.store.transaction(() => {
      this.pending(this.owner(actor, id));
      const result = this.command(`user:${actor}`, `reissue:${id}`, key, {}, () => {
        const count = this.store.db.prepare("SELECT COUNT(*) AS total FROM invitation_events WHERE invitation_id = ? AND action = 'reissue' AND at > ?").get(id, this.clock() - 3_600_000)!;
        if (Number(count.total) >= INVITATION_POLICY.maximumReissuesPerHour) throw new DomainError('REISSUE_LIMIT', 'リンクの再発行は時間をおいてお試しください。', 429);
        const token = newToken();
        this.store.db.prepare('UPDATE invitations SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
        this.event(id, `user:${actor}`, 'reissue');
        return { id, token };
      });
      return { invitation: this.view(this.owner(actor, id), true), ...('token' in result ? { token: result.token } : {}) };
    });
  }
  private cancelInternal(row: InvitationRow, reason: string, actor: string) {
    if (row.state !== 'pending') return;
    const updated = this.store.db.prepare("UPDATE invitations SET state = 'cancelled', cancelled_reason = ? WHERE id = ? AND state = 'pending'").run(reason, row.id);
    if (Number(updated.changes) === 1) this.event(row.id, actor, 'release');
  }
  withdraw(actor: string, id: string, key: string): InvitationView {
    this.commissions.session(actor);
    this.expire();
    this.owner(actor, id);
    this.command(`user:${actor}`, `withdraw:${id}`, key, {}, () => {
      const row = this.owner(actor, id);
      if (row.state === 'accepted') throw new DomainError('INVITATION_CLOSED', '受取済みの依頼は、依頼一覧で確認してください。');
      this.cancelInternal(row, 'withdrawn', `user:${actor}`);
      return { id };
    });
    return this.view(this.row(id), true);
  }
  decline(account: SocialAccount, token: string, key: string): InvitationView {
    this.expire();
    return this.store.transaction(() => {
      const row = this.recipient(account, token);
      this.command(socialActor(account), `decline:${row.id}`, key, {}, () => {
        if (row.state === 'accepted') throw new DomainError('INVITATION_CLOSED', '受取済みの依頼は、依頼一覧で確認してください。');
        this.cancelInternal(row, 'declined', socialActor(account));
        return { id: row.id };
      });
      return this.view(this.row(row.id), false);
    });
  }
  accept(account: SocialAccount, token: string, key: string, agreed: boolean): InvitationView {
    this.expire();
    return this.store.transaction(() => {
      const row = this.recipient(account, token);
      if (agreed !== true) throw new DomainError('RULES_REQUIRED', '登録と依頼のルールへの同意が必要です。', 400);
      this.command(socialActor(account), `accept:${row.id}`, key, { agreed: true }, () => {
        this.pending(row);
        if (this.preference(account).blocked) throw new DomainError('INVITATIONS_DISABLED', '招待の受信を停止しています。');
        const actor = this.auth.registerRecipient(account);
        const request = this.commissions.receiveInvitation(actor, row.client_id, {
          brief: row.brief, amount: row.amount, visibility: row.visibility, nsfw: Boolean(row.nsfw), agreeToRules: true,
        }, { createdAt: row.created_at, expiresAt: row.expires_at, deliverBy: row.deliver_by }, key);
        this.store.db.prepare("UPDATE invitations SET state = 'accepted', request_id = ? WHERE id = ?").run(request.id, row.id);
        this.event(row.id, socialActor(account), 'accept');
        return { id: row.id };
      });
      return this.view(this.row(row.id), false);
    });
  }
  preference(account: SocialAccount): { blocked: boolean } {
    const row = this.store.db.prepare('SELECT blocked FROM invitation_preferences WHERE provider = ? AND subject = ?').get(account.provider, account.subject);
    return { blocked: row?.blocked === 1 };
  }
  setPreference(account: SocialAccount, blocked: boolean): { blocked: boolean } {
    if (typeof blocked !== 'boolean') throw new DomainError('INVALID_INPUT', '受信設定を確認してください。', 400);
    this.expire();
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO invitation_preferences VALUES (?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET blocked = excluded.blocked`).run(account.provider, account.subject, Number(blocked));
      if (blocked) {
        const rows = this.store.db.prepare("SELECT * FROM invitations WHERE recipient_provider = ? AND recipient_subject = ? AND state = 'pending'").all(account.provider, account.subject) as unknown as InvitationRow[];
        for (const row of rows) this.cancelInternal(row, 'recipient_blocked', socialActor(account));
      }
      return { blocked };
    });
  }
  expire(): number {
    return this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT * FROM invitations WHERE state = 'pending' AND expires_at <= ?").all(this.clock()) as unknown as InvitationRow[];
      for (const row of rows) this.cancelInternal(row, 'expired', 'system');
      return rows.length;
    });
  }
}
