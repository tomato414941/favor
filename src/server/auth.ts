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
  constructor(readonly store: Store, readonly clock: () => number = Date.now) {}

  resolveDemoRecipient(handle: string): SocialAccount {
    const normalized = handle.trim().replace(/^@/, '').toLowerCase();
    const account = Object.values(DEMO_ACCOUNTS).find((candidate) => candidate.handle === normalized);
    if (!account) throw new DomainError('RECIPIENT_NOT_FOUND', '体験用の宛先は @mio_demo または @sora_demo を指定してください。', 404);
    const { userId: _userId, ...view } = account;
    return view;
  }

  demoLogin(persona: DemoPersona): string {
    const account = DEMO_ACCOUNTS[persona];
    if (!account) throw new DomainError('INVALID_ACCOUNT', '体験するアカウントを選んでください。', 400);
    return this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO social_accounts (provider, subject, handle, name, user_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET handle = excluded.handle, name = excluded.name`).run(
          account.provider, account.subject, account.handle, account.name, account.userId);
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
    const row = this.store.db.prepare('SELECT * FROM social_accounts WHERE provider = ? AND subject = ?').get(account.provider, account.subject) as unknown as AccountRow | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'アカウントの確認が必要です。', 401);
    if (row.user_id) {
      this.store.db.prepare('UPDATE users SET creator_enabled = 1 WHERE id = ?').run(row.user_id);
      return row.user_id;
    }
    const id = randomUUID();
    this.store.db.prepare("INSERT INTO users (id, name, role, points, creator_enabled) VALUES (?, ?, 'creator', 0, 1)").run(id, row.name);
    this.store.db.prepare('UPDATE social_accounts SET user_id = ? WHERE provider = ? AND subject = ?').run(id, account.provider, account.subject);
    return id;
  }
}
