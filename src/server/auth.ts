import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IdentitySession, SocialAccount } from '../shared.js';
import { DomainError } from './service.js';
import { Store } from './store.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export type DemoPersona = 'client' | 'creator' | 'recipient' | 'other';
const DEMO_ACCOUNTS: Record<DemoPersona, SocialAccount & { userId: string | null }> = {
  client: { provider: 'demo', subject: 'social-aoba', handle: 'aoba_demo', name: '青葉 / aoba', userId: 'demo-client' },
  creator: { provider: 'demo', subject: 'social-nagi', handle: 'nagi_demo', name: '凪 / nagi', userId: 'demo-creator' },
  recipient: { provider: 'demo', subject: 'social-mio', handle: 'mio_demo', name: '澪 / mio', userId: null },
  other: { provider: 'demo', subject: 'social-sora', handle: 'sora_demo', name: '空 / sora', userId: null },
};
interface AccountRow { provider: string; subject: string; handle: string; name: string; user_id: string | null }

/** Authentication boundary. Demo accounts are available only through explicitly enabled demo routes. */
export class AuthService {
  constructor(readonly store: Store, readonly clock: () => number = Date.now, readonly options: { allowDemo?: boolean; allowX?: boolean; allowLocal?: boolean } = {}) {}

  limit(bucket: string, maximum = 30) {
    const now = this.clock();
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM auth_limits WHERE started_at <= ?').run(now - 600_000);
      const id = hashToken(bucket);
      const row = this.store.db.prepare('SELECT attempts FROM auth_limits WHERE bucket = ?').get(id);
      if (row && Number(row.attempts) >= maximum) throw new DomainError('AUTH_RATE_LIMIT', '操作の回数が上限に達しました。時間をおいてお試しください。', 429);
      this.store.db.prepare('INSERT INTO auth_limits VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(id, now);
    });
  }

  createLocal(input: { login: string; name: string; salt: string; passwordHash: string }): string {
    if (!this.options.allowLocal) throw new DomainError('AUTH_DISABLED', 'アカウントの登録は利用できません。', 403);
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM local_credentials WHERE login = ?').get(input.login)) throw new DomainError('LOGIN_TAKEN', 'このログインIDは登録済みです。別のIDを使うか、ログインしてください。');
      const subject = randomUUID();
      this.store.db.prepare('INSERT INTO local_credentials VALUES (?, ?, ?, ?)').run(input.login, subject, input.salt, input.passwordHash);
      this.store.db.prepare("INSERT INTO social_accounts (provider, subject, handle, name) VALUES ('local', ?, ?, ?)").run(subject, input.login, input.name);
      const token = this.localSession(subject);
      this.registerAccount(token, true);
      return token;
    });
  }

  localSession(subject: string): string {
    if (!this.options.allowLocal) throw new DomainError('AUTH_DISABLED', 'ログインは利用できません。', 403);
    const row = this.store.db.prepare("SELECT * FROM social_accounts WHERE provider = 'local' AND subject = ?").get(subject) as unknown as AccountRow | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'ログインIDとパスワードを確認してください。', 401);
    return this.issueSession(row);
  }

  private requireDemo() {
    if (this.options.allowDemo !== true) throw new DomainError('DEMO_DISABLED', '体験用の認証は利用できません。', 403);
  }

  resolveDemoRecipient(handle: string): SocialAccount {
    this.requireDemo();
    const normalized = handle.trim().replace(/^@/, '').toLowerCase();
    const account = Object.values(DEMO_ACCOUNTS).find((candidate) => candidate.handle === normalized);
    if (!account) throw new DomainError('RECIPIENT_NOT_FOUND', '体験用の宛先は @mio_demo または @sora_demo を指定してください。', 404);
    const { userId: _userId, ...view } = account;
    return view;
  }

  demoLogin(persona: DemoPersona): string {
    this.requireDemo();
    const account = DEMO_ACCOUNTS[persona];
    if (!account) throw new DomainError('INVALID_ACCOUNT', '体験するアカウントを選んでください。', 400);
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO social_accounts (provider, subject, handle, name, user_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET handle = excluded.handle, name = excluded.name`).run(
          account.provider, account.subject, account.handle, account.name, account.userId);
      return this.issueSession(account);
    });
  }

  /** The account must come from X's authenticated /2/users/me response. */
  xLogin(account: SocialAccount, previousSessionHash: string | null): string {
    if (this.options.allowX !== true || account.provider !== 'x') throw new DomainError('AUTH_DISABLED', 'Xでのログインは利用できません。', 403);
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO social_accounts (provider, subject, handle, name) VALUES ('x', ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET handle = excluded.handle, name = excluded.name`).run(account.subject, account.handle, account.name);
      const row = this.store.db.prepare("SELECT user_id FROM social_accounts WHERE provider = 'x' AND subject = ?").get(account.subject)!;
      if (row.user_id) this.store.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(account.name, row.user_id);
      if (previousSessionHash) this.store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(previousSessionHash);
      return this.issueSession(account);
    });
  }

  private issueSession(account: SocialAccount): string {
    const token = newToken();
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.clock());
    this.store.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), account.provider, account.subject, this.clock() + 86_400_000);
    return token;
  }

  private account(token: string | undefined): AccountRow {
    if (!isToken(token)) throw new DomainError('UNAUTHORIZED', 'アカウントの確認が必要です。', 401);
    const row = this.store.db.prepare(`SELECT a.* FROM sessions s JOIN social_accounts a
      ON a.provider = s.provider AND a.subject = s.subject WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), this.clock()) as unknown as AccountRow | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'demo' && this.options.allowDemo !== true) throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'x' && this.options.allowX !== true) throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'local' && this.options.allowLocal !== true) throw new DomainError('UNAUTHORIZED', 'ログインし直してください。', 401);
    if (!['demo', 'x', 'local'].includes(row.provider)) throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    return row;
  }

  identity(token: string | undefined): IdentitySession {
    const { user_id: userId, ...account } = this.account(token);
    return { account, registered: userId !== null };
  }
  actor(token: string | undefined): string {
    const account = this.account(token);
    if (!account.user_id) throw new DomainError('REGISTRATION_REQUIRED', '依頼を受けるには登録が必要です。', 401);
    return account.user_id;
  }
  logout(token: string | undefined) {
    if (isToken(token)) this.store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  /** Called only after invitation authorization and explicit acceptance, inside the same transaction. */
  registerRecipient(account: SocialAccount): string {
    return this.register(account, true);
  }
  registerAccount(token: string | undefined, agreed: boolean): string {
    if (agreed !== true) throw new DomainError('RULES_REQUIRED', '登録と依頼のルールへの同意が必要です。', 400);
    return this.store.transaction(() => this.register(this.identity(token).account, false));
  }
  private register(account: SocialAccount, creator: boolean): string {
    const row = this.store.db.prepare('SELECT * FROM social_accounts WHERE provider = ? AND subject = ?').get(account.provider, account.subject) as unknown as AccountRow | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'アカウントの確認が必要です。', 401);
    if (row.user_id) {
      if (creator) this.store.db.prepare('UPDATE users SET creator_enabled = 1 WHERE id = ?').run(row.user_id);
      return row.user_id;
    }
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO users (id, name, role, points, creator_enabled) VALUES (?, ?, ?, 0, ?)').run(id, row.name, creator ? 'creator' : 'client', Number(creator));
    this.store.db.prepare('UPDATE social_accounts SET user_id = ? WHERE provider = ? AND subject = ?').run(id, account.provider, account.subject);
    this.store.db.prepare('INSERT INTO registration_consents VALUES (?, ?, ?)').run(id, 'commission-rules-v1', this.clock());
    return id;
  }
}
