import { randomInt, timingSafeEqual } from 'node:crypto';
import { AuthService, hashToken, isToken, newToken } from './auth.js';
import { DomainError } from './service.js';

export type EmailDelivery = (message: { to: string; code: string }) => Promise<void>;
const normalize = (email: string) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const emailValid = (email: string) =>
  email.length <= 254 &&
  email.split('@')[0]!.length <= 64 &&
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    email,
  );
const invalidCode = () =>
  new DomainError('INVALID_CODE', '確認コードが違うか、有効期限が切れています。', 401);

export class EmailAuth {
  constructor(
    readonly auth: AuthService,
    private readonly deliver: EmailDelivery,
  ) {}

  async start(input: string, previous?: string): Promise<string> {
    const email = normalize(input);
    if (!emailValid(email))
      throw new DomainError('INVALID_EMAIL', 'メールアドレスを正しく入力してください。', 400);
    this.auth.limit(`email-send:${email}`, 3);
    this.auth.limit('email-send:all', 100);
    const challenge = newToken();
    const code = String(randomInt(100_000_000)).padStart(8, '0');
    const db = this.auth.store.db;
    this.auth.store.transaction(() => {
      db.prepare('DELETE FROM email_challenges WHERE expires_at <= ?').run(this.auth.clock());
      db.prepare(
        'INSERT INTO email_challenges (token_hash, email, code_hash, expires_at) VALUES (?, ?, ?, ?)',
      ).run(
        hashToken(challenge),
        email,
        hashToken(`${challenge}:${code}`),
        this.auth.clock() + 600_000,
      );
    });
    try {
      await this.deliver({ to: email, code });
    } catch {
      db.prepare('DELETE FROM email_challenges WHERE token_hash = ?').run(hashToken(challenge));
      throw new DomainError(
        'EMAIL_UNAVAILABLE',
        'メールを送信できませんでした。時間をおいてお試しください。',
        503,
      );
    }
    this.cancel(previous);
    return challenge;
  }

  cancel(challenge: string | undefined) {
    if (isToken(challenge))
      this.auth.store.db
        .prepare('DELETE FROM email_challenges WHERE token_hash = ?')
        .run(hashToken(challenge));
  }

  verify(challenge: string | undefined, code: string, previousSession?: string): string {
    if (!isToken(challenge)) throw invalidCode();
    // Failed attempts must commit even though the HTTP request returns an error.
    const token = this.auth.store.transaction(() => {
      const db = this.auth.store.db;
      const row = db
        .prepare('SELECT * FROM email_challenges WHERE token_hash = ?')
        .get(hashToken(challenge));
      if (!row) return null;
      if (Number(row.expires_at) <= this.auth.clock() || Number(row.attempts) >= 5) {
        db.prepare('DELETE FROM email_challenges WHERE token_hash = ?').run(hashToken(challenge));
        return null;
      }
      db.prepare('UPDATE email_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(
        hashToken(challenge),
      );
      if (
        typeof code !== 'string' ||
        !/^\d{8}$/.test(code) ||
        !timingSafeEqual(
          Buffer.from(String(row.code_hash), 'hex'),
          Buffer.from(hashToken(`${challenge}:${code}`), 'hex'),
        )
      )
        return null;
      db.prepare('DELETE FROM email_challenges WHERE token_hash = ?').run(hashToken(challenge));
      const session = this.auth.emailSession(String(row.email));
      this.auth.logout(previousSession);
      return session;
    });
    if (!token) throw invalidCode();
    return token;
  }
}
