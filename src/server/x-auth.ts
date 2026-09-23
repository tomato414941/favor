import { createHash } from 'node:crypto';
import type { SocialAccount } from '../shared.js';
import { AuthService, hashToken, isToken, newToken } from './auth.js';
import { DomainError } from './service.js';
import { parsePublicOrigin } from './public-origin.js';

export interface XConfig {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  appBearerToken?: string;
}
export type XFetch = (url: string, init: RequestInit) => Promise<Response>;
const FLOW_MS = 600_000;
export const X_SCOPES = 'tweet.read users.read';
const unavailable = () => new DomainError('X_UNAVAILABLE', 'Xのアカウントを確認できませんでした。時間をおいてお試しください。', 503);
const invalidFlow = () => new DomainError('OAUTH_EXPIRED', '確認の有効期限が切れました。もう一度Xでログインしてください。', 400);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function normalizeXHandle(input: string): string {
  let handle = input.trim();
  if (/^https?:\/\//i.test(handle)) {
    let url: URL;
    try { url = new URL(handle); } catch { throw new DomainError('INVALID_RECIPIENT', 'Xのユーザー名またはプロフィールURLを入力してください。', 400); }
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname)) {
      throw new DomainError('INVALID_RECIPIENT', 'Xのユーザー名またはプロフィールURLを入力してください。', 400);
    }
    handle = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  } else handle = handle.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new DomainError('INVALID_RECIPIENT', 'Xのユーザー名またはプロフィールURLを入力してください。', 400);
  return handle.toLowerCase();
}

/** Endpoint URLs are fixed, never supplied by a browser or a redirect response. */
export class XProvider {
  readonly publicOrigin: string;
  readonly callbackUrl: string;
  readonly secureCookies: boolean;
  constructor(private readonly config: XConfig, private readonly request: XFetch = fetch) {
    const origin = parsePublicOrigin(config.publicOrigin);
    if (!config.clientId.trim() || !config.clientSecret.trim()) throw new Error('X_CLIENT_ID and X_CLIENT_SECRET are required in X authentication mode.');
    this.publicOrigin = origin.origin;
    this.callbackUrl = `${origin.origin}/api/auth/x/callback`;
    this.secureCookies = origin.protocol === 'https:';
  }
  get lookupEnabled() { return Boolean(this.config.appBearerToken?.trim()); }
  authorize(state: string, challenge: string): string {
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.callbackUrl,
      scope: X_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.href;
  }
  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    try {
      const response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.status === 429) throw new DomainError('X_RATE_LIMIT', 'Xへの確認が混み合っています。時間をおいてお試しください。', 429);
      if (response.status === 404 && url.includes('/users/by/username/')) throw new DomainError('RECIPIENT_NOT_FOUND', 'Xのアカウントが見つかりません。ユーザー名を確認してください。', 404);
      if (!response.ok) throw unavailable();
      return object(await response.json());
    } catch (error) { if (error instanceof DomainError) throw error; throw unavailable(); }
  }
  private account(payload: Record<string, unknown>): SocialAccount {
    const user = object(payload.data);
    if (typeof user.id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(user.id)
      || typeof user.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(user.username)
      || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 200) throw unavailable();
    return { provider: 'x', subject: user.id, handle: user.username, name: user.name };
  }
  async authenticate(code: string, verifier: string): Promise<SocialAccount> {
    const basic = Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64');
    const token = await this.json('https://api.x.com/2/oauth2/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: this.callbackUrl, code_verifier: verifier }).toString(),
    });
    if (token.token_type !== 'bearer' && token.token_type !== 'Bearer') throw unavailable();
    if (typeof token.access_token !== 'string' || !token.access_token || /\s/.test(token.access_token)
      || typeof token.scope !== 'string' || !X_SCOPES.split(' ').every((scope) => (token.scope as string).split(' ').includes(scope))) throw unavailable();
    // No offline scope, refresh token or user access token is saved or returned to the browser.
    return this.account(await this.json('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token.access_token}` } }));
  }
  async lookup(input: string): Promise<SocialAccount> {
    const handle = normalizeXHandle(input);
    if (!this.lookupEnabled) throw new DomainError('X_LOOKUP_DISABLED', '招待先の確認は現在利用できません。時間をおいてお試しください。', 503);
    const account = this.account(await this.json(`https://api.x.com/2/users/by/username/${handle}`, {
      headers: { Authorization: `Bearer ${this.config.appBearerToken}` },
    }));
    if (account.handle.toLowerCase() !== handle) throw unavailable();
    return account;
  }
}

export class XAuth {
  constructor(readonly auth: AuthService, readonly provider: XProvider) {}
  limit(bucket: string, maximum: number) {
    const now = this.auth.clock();
    this.auth.store.transaction(() => {
      const db = this.auth.store.db;
      db.prepare('DELETE FROM auth_limits WHERE started_at <= ?').run(now - FLOW_MS);
      const id = hashToken(bucket);
      const row = db.prepare('SELECT attempts FROM auth_limits WHERE bucket = ?').get(id);
      if (row && Number(row.attempts) >= maximum) throw new DomainError('AUTH_RATE_LIMIT', '確認の回数が上限に達しました。時間をおいてお試しください。', 429);
      db.prepare('INSERT INTO auth_limits VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(id, now);
    });
  }
  cleanup() { this.auth.store.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(this.auth.clock()); }
  start(ip: string, previousBrowser: string | undefined, previousSession: string | undefined) {
    this.limit(`login:${ip}`, 30);
    this.cleanup();
    const state = newToken(); const browser = newToken(); const verifier = newToken();
    this.auth.store.transaction(() => {
      if (isToken(previousBrowser)) this.cancel(previousBrowser);
      if (Number(this.auth.store.db.prepare('SELECT COUNT(*) AS total FROM oauth_flows').get()!.total) >= 1000) throw unavailable();
      this.auth.store.db.prepare('INSERT INTO oauth_flows VALUES (?, ?, ?, ?, ?)').run(hashToken(state), hashToken(browser), verifier,
        isToken(previousSession) ? hashToken(previousSession) : null, this.auth.clock() + FLOW_MS);
    });
    return { browser, url: this.provider.authorize(state, createHash('sha256').update(verifier).digest('base64url')) };
  }
  cancel(browser: string | undefined) {
    if (isToken(browser)) this.auth.store.db.prepare('DELETE FROM oauth_flows WHERE browser_hash = ?').run(hashToken(browser));
  }
  async finish(browser: string | undefined, query: Record<string, unknown>): Promise<string> {
    this.cleanup();
    if (!isToken(browser) || !isToken(query.state)) throw invalidFlow();
    const state = query.state;
    const row = this.auth.store.transaction(() => {
      const flow = this.auth.store.db.prepare("SELECT * FROM oauth_flows WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? AND verifier != ''")
        .get(hashToken(state), hashToken(browser), this.auth.clock());
      if (!flow) throw invalidFlow();
      this.auth.store.db.prepare("UPDATE oauth_flows SET verifier = '' WHERE state_hash = ?").run(hashToken(state));
      return flow;
    });
    try {
      if (query.error === 'access_denied') throw new DomainError('OAUTH_CANCELLED', 'Xでの確認を中止しました。', 400);
      if (query.error !== undefined || typeof query.code !== 'string' || !query.code || query.code.length > 2048) throw invalidFlow();
      const account = await this.provider.authenticate(query.code, String(row.verifier));
      return this.auth.store.transaction(() => {
        // Logout or a newer login can cancel the flow while the provider request is in flight.
        if (!this.auth.store.db.prepare('SELECT 1 FROM oauth_flows WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?')
          .get(hashToken(state), hashToken(browser), this.auth.clock())) throw invalidFlow();
        return this.auth.xLogin(account, row.previous_session_hash === null ? null : String(row.previous_session_hash));
      });
    } finally { this.auth.store.db.prepare('DELETE FROM oauth_flows WHERE state_hash = ?').run(hashToken(state)); }
  }
}
