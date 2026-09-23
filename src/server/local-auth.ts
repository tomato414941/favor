import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { LocalCredentials, LocalRegistration } from '../shared.js';
import { AuthService } from './auth.js';
import { DomainError } from './service.js';

const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
const normalize = (email: string) => (typeof email === 'string' ? email.trim().toLowerCase() : '');
const passwordValid = (password: string) =>
  typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 1024;
const emailValid = (email: string) =>
  email.length <= 254 &&
  email.split('@')[0]!.length <= 64 &&
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    email,
  );
const invalidEmail = () =>
  new DomainError('INVALID_EMAIL', 'メールアドレスを正しく入力してください。', 400);
const loginError = 'メールアドレスとパスワードを確認してください。';

export class LocalAuth {
  constructor(readonly auth: AuthService) {}

  async register(input: LocalRegistration, previousSession?: string): Promise<string> {
    const email = normalize(input.email);
    if (!emailValid(email)) throw invalidEmail();
    if (!passwordValid(input.password))
      throw new DomainError(
        'INVALID_PASSWORD',
        'パスワードは12文字以上、1,024バイト以内で入力してください。',
        400,
      );
    if (input.agreeToRules !== true)
      throw new DomainError('RULES_REQUIRED', '登録と依頼のルールへの同意が必要です。', 400);
    const salt = randomBytes(32).toString('hex');
    const passwordHash = (await derive(input.password, salt)).toString('hex');
    return this.auth.store.transaction(() => {
      const token = this.auth.createLocal({ email, salt, passwordHash });
      this.auth.logout(previousSession);
      return token;
    });
  }

  async login(input: LocalCredentials, previousSession?: string): Promise<string> {
    const email = normalize(input.email);
    if (!emailValid(email) || !passwordValid(input.password))
      throw new DomainError('UNAUTHORIZED', loginError, 401);
    this.auth.limit(`password:${email}`, 10);
    const row = this.auth.store.db
      .prepare('SELECT * FROM local_credentials WHERE email = ?')
      .get(email);
    const actual = await derive(input.password, row ? String(row.salt) : 'unregistered-account');
    const expected = row ? Buffer.from(String(row.password_hash), 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(actual, expected) || !row)
      throw new DomainError('UNAUTHORIZED', loginError, 401);
    return this.auth.store.transaction(() => {
      const token = this.auth.localSession(String(row.subject));
      this.auth.logout(previousSession);
      return token;
    });
  }
}
