import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { LocalCredentials, LocalRegistration } from '../shared.js';
import { AuthService } from './auth.js';
import { DomainError } from './service.js';

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result));
});
const normalize = (login: string) => typeof login === 'string' ? login.trim().toLowerCase() : '';
const passwordValid = (password: string) => typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 1024;

export class LocalAuth {
  constructor(readonly auth: AuthService) {}

  async register(input: LocalRegistration, previousSession?: string): Promise<string> {
    const login = normalize(input.login);
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(login)) throw new DomainError('INVALID_LOGIN', 'ログインIDは半角英数字・ハイフン・アンダースコアの3〜32文字で入力してください。先頭は英数字にしてください。', 400);
    if (!passwordValid(input.password)) throw new DomainError('INVALID_PASSWORD', 'パスワードは12文字以上、1,024バイト以内で入力してください。', 400);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw new DomainError('INVALID_NAME', '表示名を1〜80文字で入力してください。', 400);
    if (input.agreeToRules !== true) throw new DomainError('RULES_REQUIRED', '登録と依頼のルールへの同意が必要です。', 400);
    const salt = randomBytes(32).toString('hex');
    const passwordHash = (await derive(input.password, salt)).toString('hex');
    return this.auth.store.transaction(() => {
      const token = this.auth.createLocal({ login, name: input.name.trim(), salt, passwordHash });
      this.auth.logout(previousSession);
      return token;
    });
  }

  async login(input: LocalCredentials, previousSession?: string): Promise<string> {
    const login = normalize(input.login);
    if (!passwordValid(input.password) || !/^[a-z0-9][a-z0-9_-]{2,31}$/.test(login)) throw new DomainError('UNAUTHORIZED', 'ログインIDとパスワードを確認してください。', 401);
    this.auth.limit(`password:${login}`, 10);
    const row = this.auth.store.db.prepare('SELECT * FROM local_credentials WHERE login = ?').get(login);
    const actual = await derive(input.password, row ? String(row.salt) : 'unregistered-account');
    const expected = row ? Buffer.from(String(row.password_hash), 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(actual, expected) || !row) throw new DomainError('UNAUTHORIZED', 'ログインIDとパスワードを確認してください。', 401);
    return this.auth.store.transaction(() => {
      const token = this.auth.localSession(String(row.subject));
      this.auth.logout(previousSession);
      return token;
    });
  }
}
