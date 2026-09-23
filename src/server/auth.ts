import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IdentitySession, SocialAccount } from '../shared.js';
import { DomainError } from './service.js';
import { Store } from './store.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export type DemoPersona = 'client' | 'creator' | 'recipient' | 'other';
const DEMO_ACCOUNTS: Record<DemoPersona, SocialAccount & { userId: string | null }> = {
  client: {
    provider: 'demo',
    subject: 'social-aoba',
    handle: 'aoba_demo',
    name: '青葉 / aoba',
    userId: 'demo-client',
  },
  creator: {
    provider: 'demo',
    subject: 'social-nagi',
    handle: 'nagi_demo',
    name: '凪 / nagi',
    userId: 'demo-creator',
  },
  recipient: {
    provider: 'demo',
    subject: 'social-mio',
    handle: 'mio_demo',
    name: '澪 / mio',
    userId: null,
  },
  other: {
    provider: 'demo',
    subject: 'social-sora',
    handle: 'sora_demo',
    name: '空 / sora',
    userId: null,
  },
};
interface AccountRow {
  provider: string;
  subject: string;
  handle: string;
  name: string;
  user_id: string | null;
}

/** Authentication boundary. Demo accounts are available only through explicitly enabled demo routes. */
export class AuthService {
  constructor(
    readonly store: Store,
    readonly clock: () => number = Date.now,
    readonly options: { allowDemo?: boolean; allowX?: boolean; allowLocal?: boolean } = {},
  ) {}

  limit(bucket: string, maximum = 30) {
    const now = this.clock();
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM auth_limits WHERE started_at <= ?').run(now - 600_000);
      const id = hashToken(bucket);
      const row = this.store.db
        .prepare('SELECT attempts FROM auth_limits WHERE bucket = ?')
        .get(id);
      if (row && Number(row.attempts) >= maximum)
        throw new DomainError(
          'AUTH_RATE_LIMIT',
          '操作の回数が上限に達しました。時間をおいてお試しください。',
          429,
        );
      this.store.db
        .prepare(
          'INSERT INTO auth_limits VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1',
        )
        .run(id, now);
    });
  }

  createLocal(input: { email: string; salt: string; passwordHash: string }): string {
    if (!this.options.allowLocal)
      throw new DomainError('AUTH_DISABLED', 'アカウントの登録は利用できません。', 403);
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM local_credentials WHERE email = ?').get(input.email))
        throw new DomainError(
          'EMAIL_TAKEN',
          'このメールアドレスは登録済みです。ログインしてください。',
        );
      const subject = randomUUID();
      const handle = `user_${subject.replaceAll('-', '')}`;
      const name = `ユーザー ${subject.slice(0, 8)}`;
      this.store.db
        .prepare('INSERT INTO local_credentials VALUES (?, ?, ?, ?)')
        .run(input.email, subject, input.salt, input.passwordHash);
      this.store.db
        .prepare(
          "INSERT INTO social_accounts (provider, subject, handle, name) VALUES ('local', ?, ?, ?)",
        )
        .run(subject, handle, name);
      const token = this.localSession(subject);
      this.registerAccount(token, true);
      return token;
    });
  }

  localSession(subject: string): string {
    if (!this.options.allowLocal)
      throw new DomainError('AUTH_DISABLED', 'ログインは利用できません。', 403);
    const row = this.store.db
      .prepare(
        `SELECT a.* FROM social_accounts a JOIN local_credentials c ON c.subject = a.subject
      WHERE a.provider = 'local' AND a.subject = ? AND instr(c.email, '@') > 1`,
      )
      .get(subject) as unknown as AccountRow | undefined;
    if (!row)
      throw new DomainError('UNAUTHORIZED', 'メールアドレスとパスワードを確認してください。', 401);
    return this.issueSession(row);
  }

  private requireDemo() {
    if (this.options.allowDemo !== true)
      throw new DomainError('DEMO_DISABLED', '体験用の認証は利用できません。', 403);
  }

  demoLogin(persona: DemoPersona): string {
    this.requireDemo();
    const account = DEMO_ACCOUNTS[persona];
    if (!account)
      throw new DomainError('INVALID_ACCOUNT', '体験するアカウントを選んでください。', 400);
    return this.store.transaction(() => {
      if (account.userId)
        this.store.db
          .prepare('INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)')
          .run(account.userId, account.name);
      this.store.db
        .prepare(
          `INSERT INTO social_accounts (provider, subject, handle, name, user_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET handle = excluded.handle, name = excluded.name`,
        )
        .run(account.provider, account.subject, account.handle, account.name, account.userId);
      return this.issueSession(account);
    });
  }

  /** The account must come from X's authenticated /2/users/me response. */
  xLogin(account: SocialAccount, previousSessionHash: string | null): string {
    if (this.options.allowX !== true || account.provider !== 'x')
      throw new DomainError('AUTH_DISABLED', 'Xでのログインは利用できません。', 403);
    return this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO social_accounts (provider, subject, handle, name) VALUES ('x', ?, ?, ?)
        ON CONFLICT(provider, subject) DO UPDATE SET handle = excluded.handle, name = excluded.name`,
        )
        .run(account.subject, account.handle, account.name);
      const row = this.store.db
        .prepare("SELECT user_id FROM social_accounts WHERE provider = 'x' AND subject = ?")
        .get(account.subject)!;
      if (row.user_id)
        this.store.db
          .prepare('UPDATE users SET name = ? WHERE id = ?')
          .run(account.name, row.user_id);
      if (previousSessionHash)
        this.store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(previousSessionHash);
      return this.issueSession(account);
    });
  }

  private issueSession(account: SocialAccount): string {
    const token = newToken();
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.clock());
    this.store.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
      .run(hashToken(token), account.provider, account.subject, this.clock() + 86_400_000);
    return token;
  }

  private account(token: string | undefined): AccountRow & { email: string | null } {
    if (!isToken(token)) throw new DomainError('UNAUTHORIZED', 'アカウントの確認が必要です。', 401);
    const row = this.store.db
      .prepare(
        `SELECT a.*, c.email AS email FROM sessions s JOIN social_accounts a
      ON a.provider = s.provider AND a.subject = s.subject
      LEFT JOIN local_credentials c ON a.provider = 'local' AND c.subject = a.subject
      WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), this.clock()) as unknown as
      (AccountRow & { email: string | null }) | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'demo' && this.options.allowDemo !== true)
      throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'x' && this.options.allowX !== true)
      throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    if (row.provider === 'local' && (this.options.allowLocal !== true || !row.email?.includes('@')))
      throw new DomainError('UNAUTHORIZED', 'ログインし直してください。', 401);
    if (!['demo', 'x', 'local'].includes(row.provider))
      throw new DomainError('UNAUTHORIZED', 'アカウントをもう一度確認してください。', 401);
    return row;
  }

  identity(token: string | undefined): IdentitySession {
    const { user_id: userId, email, ...account } = this.account(token);
    return {
      account,
      registered: userId !== null,
      ...(account.provider === 'local' ? { email: email! } : {}),
    };
  }
  actor(token: string | undefined): string {
    const account = this.account(token);
    if (!account.user_id)
      throw new DomainError('REGISTRATION_REQUIRED', '依頼を受けるには登録が必要です。', 401);
    return account.user_id;
  }
  logout(token: string | undefined) {
    if (isToken(token))
      this.store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  /** Called only after link authorization and explicit acceptance, inside the same transaction. */
  registerRecipient(account: SocialAccount): string {
    return this.register(account);
  }
  registerAccount(token: string | undefined, agreed: boolean): string {
    if (agreed !== true)
      throw new DomainError('RULES_REQUIRED', '登録と依頼のルールへの同意が必要です。', 400);
    return this.store.transaction(() => this.register(this.identity(token).account));
  }
  private register(account: SocialAccount): string {
    const row = this.store.db
      .prepare('SELECT * FROM social_accounts WHERE provider = ? AND subject = ?')
      .get(account.provider, account.subject) as unknown as AccountRow | undefined;
    if (!row) throw new DomainError('UNAUTHORIZED', 'アカウントの確認が必要です。', 401);
    if (row.user_id) return row.user_id;
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, row.name);
    this.store.db
      .prepare('UPDATE social_accounts SET user_id = ? WHERE provider = ? AND subject = ?')
      .run(id, account.provider, account.subject);
    this.store.db
      .prepare('INSERT INTO registration_consents VALUES (?, ?, ?)')
      .run(id, 'commission-rules-v1', this.clock());
    return id;
  }
}
