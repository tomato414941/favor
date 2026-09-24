import { createHash, randomBytes } from 'node:crypto';
import type { IdentitySession, SocialAccount } from '../shared.js';
import type { IdentityRequest, IdentityResolver, ResolvedIdentity } from './identity.js';
import { DomainError } from './service.js';
import { Store } from './store.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export type DemoPersona = 'client' | 'creator' | 'recipient' | 'other';
const DEMO_ACCOUNTS: Record<DemoPersona, ResolvedIdentity> = {
  client: { subject: 'demo-client', email: 'aoba@favor.test', name: '青葉 / aoba' },
  creator: { subject: 'demo-creator', email: 'nagi@favor.test', name: '凪 / nagi' },
  recipient: { subject: 'demo-recipient', email: 'mio@favor.test', name: '澪 / mio' },
  other: { subject: 'demo-other', email: 'sora@favor.test', name: '空 / sora' },
};
const unauthorized = () => new DomainError('UNAUTHORIZED', 'ログインしてください。', 401);

/**
 * Turns a verified identity into a Favor user. The identity provider (Clerk in
 * production) owns credentials and sessions; Favor keeps only the user row.
 * Demo tokens are held in memory for local use and tests.
 */
export class AuthService {
  private readonly demoSessions = new Map<string, ResolvedIdentity>();
  constructor(
    readonly store: Store,
    readonly clock: () => number = Date.now,
    readonly options: { allowDemo?: boolean; resolver?: IdentityResolver } = {},
  ) {}

  private requireDemo() {
    if (this.options.allowDemo !== true)
      throw new DomainError('DEMO_DISABLED', '体験用の認証は利用できません。', 403);
  }
  /** Ensures a user row for an identity and returns the session view of it. */
  private admit(identity: ResolvedIdentity): IdentitySession {
    this.store.db
      .prepare(
        `INSERT INTO users (id, name, email) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email`,
      )
      .run(identity.subject, identity.name, identity.email);
    const account: SocialAccount = {
      provider: this.options.resolver ? 'clerk' : 'demo',
      subject: identity.subject,
      handle: identity.email ?? identity.subject,
      name: identity.name,
    };
    return { account, registered: true, ...(identity.email ? { email: identity.email } : {}) };
  }
  demoLogin(persona: DemoPersona): string {
    this.requireDemo();
    const identity = DEMO_ACCOUNTS[persona];
    if (!identity)
      throw new DomainError('INVALID_ACCOUNT', '体験するアカウントを選んでください。', 400);
    return this.issue(identity);
  }
  /** Signs in as any address without a provider; only for local runs and tests. */
  demoLoginEmail(input: string, name?: string): string {
    this.requireDemo();
    const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new DomainError('INVALID_EMAIL', 'メールアドレスを正しく入力してください。', 400);
    const subject = `demo_${hashToken(email).slice(0, 16)}`;
    return this.issue({ subject, email, name: name?.trim() || `ユーザー ${subject.slice(5, 13)}` });
  }
  private issue(identity: ResolvedIdentity): string {
    const token = newToken();
    this.demoSessions.set(hashToken(token), identity);
    this.admit(identity);
    return token;
  }
  /** Identity for a demo token issued by this process. */
  identity(token: string | undefined): IdentitySession {
    if (!isToken(token)) throw unauthorized();
    const identity = this.demoSessions.get(hashToken(token));
    if (!identity || this.options.allowDemo !== true) throw unauthorized();
    return this.admit(identity);
  }
  actor(token: string | undefined): string {
    return this.identity(token).account.subject;
  }
  logout(token: string | undefined) {
    if (isToken(token)) this.demoSessions.delete(hashToken(token));
  }
  /** Identity for an HTTP request: the provider's session, or a demo token. */
  async resolve(request: IdentityRequest, demoToken: string | undefined): Promise<IdentitySession> {
    if (this.options.resolver) {
      const identity = await this.options.resolver(request);
      if (identity) return this.admit(identity);
      throw unauthorized();
    }
    return this.identity(demoToken);
  }
  /** Recipients are already users; accepting a link only needs their id. */
  registerRecipient(account: SocialAccount): string {
    const row = this.store.db.prepare('SELECT id FROM users WHERE id = ?').get(account.subject);
    if (!row) throw unauthorized();
    return account.subject;
  }
}
