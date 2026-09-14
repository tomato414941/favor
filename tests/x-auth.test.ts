import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { AuthService, hashToken, newToken } from '../src/server/auth.js';
import { buildApp } from '../src/server/app.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { normalizeXHandle, XAuth, XProvider, X_SCOPES, type XConfig, type XFetch } from '../src/server/x-auth.js';

const config: XConfig = { clientId: 'fixture-client', clientSecret: 'fixture-secret', appBearerToken: 'fixture-app-token', publicOrigin: 'https://commission.example' };
const users = {
  sender: { id: '1234567890123456789', username: 'aoba_fixture', name: '青葉' },
  recipient: { id: '9876543210987654321', username: 'mio_fixture', name: '澪' },
  other: { id: '1111111111111111111', username: 'sora_fixture', name: '空' },
};
type Persona = keyof typeof users;
const input = { recipientHandle: '@mio_fixture', brief: '星を題材にした、未公開の物語をお願いします。', amount: 12000, visibility: 'anonymous', nsfw: true, agreeToRules: true };
const codeIs = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function providerFixture(overrides: Partial<XConfig> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let persona: Persona = 'sender';
  let failure: number | null = null;
  let renamed = false;
  const request: XFetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (failure) return Response.json({ error: 'UPSTREAM_SECRET_MUST_NOT_ESCAPE' }, { status: failure });
    if (url === 'https://api.x.com/2/oauth2/token') {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), `${overrides.publicOrigin ?? config.publicOrigin}/api/auth/x/callback`);
      assert.match(form.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(new Headers(init.headers).get('Authorization'), `Basic ${Buffer.from('fixture-client:fixture-secret').toString('base64')}`);
      assert.equal(form.has('client_secret'), false);
      return Response.json({ access_token: 'fixture-user-token', token_type: 'bearer', scope: X_SCOPES, expires_in: 7200 });
    }
    if (url === 'https://api.x.com/2/users/me') {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-user-token');
      const account = users[persona];
      return Response.json({ data: { ...account, ...(renamed ? { username: 'renamed_user', name: '新しい名前' } : {}) } });
    }
    const match = url.match(/^https:\/\/api\.x\.com\/2\/users\/by\/username\/([a-z0-9_]+)$/);
    if (match) {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-app-token');
      const account = Object.values(users).find((user) => user.username === match[1]);
      return account ? Response.json({ data: account }) : Response.json({ errors: [] }, { status: 404 });
    }
    throw new Error('Unexpected provider endpoint');
  };
  return { provider: new XProvider({ ...config, ...overrides }, request), calls,
    persona: (next: Persona) => { persona = next; }, failure: (status: number | null) => { failure = status; }, rename: () => { renamed = true; } };
}

function setup() {
  let now = 1_800_000_000_000;
  const store = new Store();
  const auth = new AuthService(store, () => now, { allowX: true });
  const fixture = providerFixture();
  const x = new XAuth(auth, fixture.provider);
  const start = (session?: string, previousBrowser?: string) => x.start('127.0.0.1', previousBrowser, session);
  const finish = (flow: ReturnType<typeof start>) => x.finish(flow.browser, { state: new URL(flow.url).searchParams.get('state'), code: 'fixture-code' });
  return { store, auth, fixture, x, start, finish, advance: (ms: number) => { now += ms; } };
}

test('X configuration and recipient URLs are exact and never become arbitrary fetch destinations', async () => {
  for (const origin of ['http://evil.example', 'https://commission.example/', 'https://user:pass@commission.example', 'https://commission.example/path', 'javascript:alert(1)', 'https://commission.example?x=1']) {
    assert.throws(() => new XProvider({ ...config, publicOrigin: origin }));
  }
  assert.throws(() => new XProvider({ ...config, clientSecret: '' }));
  assert.equal(new XProvider({ ...config, publicOrigin: 'http://127.0.0.1:3211' }).secureCookies, false);
  assert.equal(new XProvider(config).secureCookies, true);
  for (const handle of [' @Mio_fixture ', 'https://x.com/mio_fixture', 'https://twitter.com/Mio_fixture/', 'https://www.x.com/mio_fixture']) assert.equal(normalizeXHandle(handle), 'mio_fixture');
  for (const handle of ['https://evil.example/a', 'https://x.com.evil.example/a', 'https://x.com@evil.example/a', 'https://evil.example@x.com/a', 'http://x.com/a', 'https://x.com:3210/a', 'https://x.com/a/status/123', 'https://x.com/a?test=1', 'https://x.com/a#test', 'https://x.com/%61', '//127.0.0.1/private', '@a/b', '@日本語', 'a'.repeat(16), '']) assert.throws(() => normalizeXHandle(handle), codeIs('INVALID_RECIPIENT'));
  const fixture = providerFixture();
  const account = await fixture.provider.lookup('https://x.com/Mio_fixture');
  assert.deepEqual(account, { provider: 'x', subject: users.recipient.id, name: '澪', handle: 'mio_fixture' });
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(() => fixture.provider.lookup('https://evil.example/a'), codeIs('INVALID_RECIPIENT'));
  assert.equal(fixture.calls.length, 1);
});

test('X login uses S256, browser-bound state and server-only exchange without implicit registration', async () => {
  const s = setup();
  try {
    const flow = s.start(); const url = new URL(flow.url);
    assert.equal(url.origin, 'https://x.com');
    assert.equal(url.pathname, '/i/oauth2/authorize');
    assert.equal(url.searchParams.get('scope'), X_SCOPES);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `${config.publicOrigin}/api/auth/x/callback`);
    assert.equal(url.href.includes(config.clientSecret), false);
    const saved = s.store.db.prepare('SELECT * FROM oauth_flows').get()!;
    assert.equal(saved.state_hash, hashToken(url.searchParams.get('state')!));
    assert.equal(saved.browser_hash, hashToken(flow.browser));
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(String(saved.verifier)).digest('base64url'));
    await assert.rejects(() => s.x.finish(newToken(), { state: url.searchParams.get('state'), code: 'forged' }), codeIs('OAUTH_EXPIRED'));
    await assert.rejects(() => s.x.finish(flow.browser, { state: newToken(), code: 'forged' }), codeIs('OAUTH_EXPIRED'));
    assert.equal(s.fixture.calls.length, 0);
    const session = await s.finish(flow);
    assert.deepEqual(s.auth.identity(session), { registered: false, account: { provider: 'x', subject: users.sender.id, handle: users.sender.username, name: users.sender.name } });
    assert.throws(() => s.auth.actor(session), codeIs('REGISTRATION_REQUIRED'));
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS total FROM users').get()!.total, 4);
    assert.deepEqual(s.store.db.prepare('SELECT * FROM oauth_flows').all(), []);
    assert.equal(JSON.stringify(s.store.db.prepare('SELECT * FROM sessions').all()).includes(session), false);
    for (const table of ['social_accounts', 'sessions', 'oauth_flows']) assert.equal(JSON.stringify(s.store.db.prepare(`SELECT * FROM ${table}`).all()).includes('fixture-user-token'), false);
    await assert.rejects(() => s.finish(flow), codeIs('OAUTH_EXPIRED'));
    assert.equal(s.fixture.calls.length, 2);
  } finally { s.store.close(); }
});

test('X registration is consented, idempotent, zero-balance, and stable across handle changes', async () => {
  const s = setup();
  try {
    const session = await s.finish(s.start());
    assert.throws(() => s.auth.registerAccount(session, false), codeIs('RULES_REQUIRED'));
    const user = s.auth.registerAccount(session, true);
    assert.equal(s.auth.registerAccount(session, true), user);
    assert.equal(s.auth.identity(session).registered, true);
    assert.equal(s.store.db.prepare('SELECT points FROM users WHERE id = ?').get(user)!.points, 0);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS total FROM registration_consents').get()!.total, 1);
    s.fixture.rename();
    const nextSession = await s.finish(s.start(session));
    assert.throws(() => s.auth.identity(session), codeIs('UNAUTHORIZED'));
    assert.equal(s.auth.actor(nextSession), user);
    assert.equal(s.auth.identity(nextSession).account.handle, 'renamed_user');
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS total FROM users').get()!.total, 5);
    assert.equal(new CommissionService(s.store).session(user).name, '新しい名前');
    assert.throws(() => new AuthService(s.store, s.auth.clock).identity(nextSession), codeIs('UNAUTHORIZED'));
    const demo = new AuthService(s.store, s.auth.clock, { allowDemo: true });
    assert.throws(() => s.auth.identity(demo.demoLogin('client')), codeIs('UNAUTHORIZED'));
  } finally { s.store.close(); }
});

test('X cancelled, expired, replaced and failed flows never create sessions or registrations', async () => {
  const s = setup();
  try {
    const denied = s.start();
    await assert.rejects(() => s.x.finish(denied.browser, { state: new URL(denied.url).searchParams.get('state'), error: 'access_denied' }), codeIs('OAUTH_CANCELLED'));
    await assert.rejects(() => s.finish(denied), codeIs('OAUTH_EXPIRED'));
    const expired = s.start(); s.advance(600_000);
    await assert.rejects(() => s.finish(expired), codeIs('OAUTH_EXPIRED'));
    const previous = s.start(); const current = s.start(undefined, previous.browser);
    await assert.rejects(() => s.finish(previous), codeIs('OAUTH_EXPIRED'));
    s.fixture.failure(503);
    await assert.rejects(() => s.finish(current), codeIs('X_UNAVAILABLE'));
    await assert.rejects(() => s.finish(current), codeIs('OAUTH_EXPIRED'));
    assert.deepEqual(s.store.db.prepare('SELECT * FROM sessions').all(), []);
    assert.deepEqual(s.store.db.prepare('SELECT * FROM oauth_flows').all(), []);
    assert.deepEqual(s.store.db.prepare('SELECT * FROM registration_consents').all(), []);
  } finally { s.store.close(); }
});

test('X pending exchange can be cancelled and concurrent callback replay is rejected', async () => {
  const store = new Store();
  const auth = new AuthService(store, Date.now, { allowX: true });
  let resume!: () => void;
  let called!: () => void;
  const started = new Promise<void>((resolve) => { called = resolve; });
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  const provider = new XProvider(config, async (url) => {
    if (url.endsWith('/token')) { called(); await wait; return Response.json({ access_token: 'fixture-token', token_type: 'bearer', scope: X_SCOPES }); }
    return Response.json({ data: users.sender });
  });
  const x = new XAuth(auth, provider);
  try {
    const flow = x.start('loopback', undefined, undefined);
    const query = { state: new URL(flow.url).searchParams.get('state'), code: 'fixture-code' };
    const pending = x.finish(flow.browser, query);
    await started;
    await assert.rejects(() => x.finish(flow.browser, query), codeIs('OAUTH_EXPIRED'));
    x.cancel(flow.browser);
    resume();
    await assert.rejects(pending, codeIs('OAUTH_EXPIRED'));
    assert.deepEqual(store.db.prepare('SELECT * FROM sessions').all(), []);
  } finally { resume(); store.close(); }
});

test('X malformed upstream responses and lookup failures fail closed without leaking provider errors', async () => {
  for (const data of [{ data: { ...users.sender, id: Number(users.sender.id) } }, { data: { ...users.sender, id: '' } }, { data: { ...users.sender, username: '<script>' } }, { data: { ...users.sender, name: '' } }, { errors: [{ detail: 'UPSTREAM_SECRET' }] }]) {
    const provider = new XProvider(config, async () => Response.json(data));
    await assert.rejects(() => provider.lookup('@aoba_fixture'), codeIs('X_UNAVAILABLE'));
  }
  const fixture = providerFixture();
  for (const [status, code] of [[429, 'X_RATE_LIMIT'], [401, 'X_UNAVAILABLE'], [403, 'X_UNAVAILABLE'], [404, 'RECIPIENT_NOT_FOUND'], [500, 'X_UNAVAILABLE']] as const) {
    fixture.failure(status);
    await assert.rejects(() => fixture.provider.lookup('@mio_fixture'), (error: unknown) => {
      assert.ok(error instanceof DomainError); assert.equal(error.code, code); assert.equal(error.message.includes('UPSTREAM_SECRET'), false); return true;
    });
  }
  await assert.rejects(() => providerFixture({ appBearerToken: '' }).provider.lookup('@mio_fixture'), codeIs('X_LOOKUP_DISABLED'));
  const timeout = new XProvider(config, async () => { throw new Error('UPSTREAM_SECRET'); });
  await assert.rejects(() => timeout.lookup('@mio_fixture'), codeIs('X_UNAVAILABLE'));
  for (const token of [{ access_token: 'token', token_type: 'bearer', scope: 'users.read' }, { access_token: '', token_type: 'bearer', scope: X_SCOPES }, { access_token: 'token', token_type: 'invalid', scope: X_SCOPES }]) {
    const provider = new XProvider(config, async () => Response.json(token));
    await assert.rejects(() => provider.authenticate('code', newToken()), codeIs('X_UNAVAILABLE'));
  }
});

test('HTTP X: cookies, fixed callback, consent, private invitations, retries and recipient matching', async () => {
  const store = new Store(); const fixture = providerFixture();
  const app = await buildApp(new CommissionService(store), { xProvider: fixture.provider });
  const headers = { host: 'commission.example', origin: config.publicOrigin, 'x-commission-action': '1' };
  const cookieValue = (response: Awaited<ReturnType<typeof app.inject>>, name: string) => response.cookies.find((entry) => entry.name === name)?.value;
  const login = async (persona: Persona, oldCookie = '') => {
    fixture.persona(persona);
    const start = await app.inject({ method: 'POST', url: '/api/auth/x/start', headers: { ...headers, cookie: oldCookie }, payload: {} });
    assert.equal(start.statusCode, 200);
    const url = new URL(start.json().url);
    const cookie = `commission_oauth=${cookieValue(start, 'commission_oauth')}`;
    assert.match(String(start.headers['set-cookie']), /HttpOnly/); assert.match(String(start.headers['set-cookie']), /SameSite=Lax/); assert.match(String(start.headers['set-cookie']), /Secure/);
    const callback = `/api/auth/x/callback?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code', returnTo: 'https://evil.example' })}`;
    assert.equal((await app.inject({ method: 'HEAD', url: callback, headers: { ...headers, cookie } })).statusCode, 404);
    const response = await app.inject({ url: callback, headers: { host: headers.host, cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.statusCode, 303);
    assert.ok(String(response.headers.location).startsWith(`${config.publicOrigin}/#auth=success&flow=`));
    assert.equal(String(response.headers.location).includes('fixture-code'), false);
    assert.equal(String(response.headers.location).includes('evil.example'), false);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(String(response.headers['set-cookie']), /SameSite=Strict/);
    const session = cookieValue(response, 'commission_session')!;
    assert.match(session, /^[A-Za-z0-9_-]{43}$/);
    return { cookie: `commission_session=${session}`, raw: session };
  };
  try {
    assert.deepEqual((await app.inject({ url: '/api/auth/options', headers })).json(), { mode: 'x', xLogin: true, invitationLookup: true });
    assert.equal((await app.inject({ url: '/api/demo/session', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/demo/session', headers, payload: { role: 'creator' } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/auth/x/start', headers })).statusCode, 404);
    for (const forged of [{ ...headers, origin: 'https://evil.example' }, { ...headers, host: 'evil.example' }, { ...headers, 'x-commission-action': '' }, { ...headers, 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/x/start', headers: forged, payload: {} })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: { agreeToRules: true } })).statusCode, 401);
    const sender = await login('sender'); const senderHeaders = { ...headers, cookie: sender.cookie };
    assert.equal((await app.inject({ method: 'POST', url: '/api/invitations', headers: senderHeaders, payload: input })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', headers: senderHeaders, payload: { agreeToRules: false } })).statusCode, 400);
    const register = () => app.inject({ method: 'POST', url: '/api/auth/register', headers: senderHeaders, payload: { agreeToRules: true, subject: users.other.id } });
    assert.equal((await register()).statusCode, 200); assert.equal((await register()).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/session', headers: senderHeaders })).json().pointsBalance, 0);
    const sendHeaders = { ...senderHeaders, 'idempotency-key': randomUUID() };
    const send = () => app.inject({ method: 'POST', url: '/api/invitations', headers: sendHeaders, payload: { ...input, recipientHandle: 'https://x.com/Mio_fixture', recipientSubject: users.other.id } });
    const created = await send(); assert.equal(created.statusCode, 201);
    const token = created.json().token;
    const calls = fixture.calls.length;
    fixture.failure(503);
    const retry = await send(); assert.equal(retry.statusCode, 201); assert.equal(retry.json().invitation.id, created.json().invitation.id); assert.equal(retry.json().token, undefined);
    assert.equal(fixture.calls.length, calls);
    const conflict = await app.inject({ method: 'POST', url: '/api/invitations', headers: sendHeaders, payload: { ...input, brief: '変更しました' } });
    assert.equal(conflict.statusCode, 409);
    fixture.failure(null);
    assert.equal(store.db.prepare('SELECT recipient_subject FROM invitations').get()!.recipient_subject, users.recipient.id);
    const stranger = await login('other');
    const invitationHeaders = { ...headers, cookie: stranger.cookie, 'x-commission-invitation': token, 'idempotency-key': randomUUID() };
    for (const url of ['/api/invitation', '/api/invitation/accept', '/api/invitation/decline']) {
      const result = await app.inject({ method: url === '/api/invitation' ? 'GET' : 'POST', url, headers: invitationHeaders, ...(url.endsWith('accept') ? { payload: { agreeToRules: true } } : {}) });
      assert.equal(result.statusCode, 404); assert.equal(result.body.includes(input.brief), false);
    }
    const recipient = await login('recipient'); const recipientHeaders = { ...invitationHeaders, cookie: recipient.cookie };
    const read = await app.inject({ url: '/api/invitation', headers: recipientHeaders });
    assert.equal(read.statusCode, 200); assert.equal(read.json().clientName, '匿名の依頼者');
    assert.equal((await app.inject({ url: '/api/auth/identity', headers: recipientHeaders })).json().registered, false);
    const accepted = await app.inject({ method: 'POST', url: '/api/invitation/accept', headers: recipientHeaders, payload: { agreeToRules: true } });
    assert.equal(accepted.statusCode, 200); assert.equal(accepted.json().state, 'accepted');
    assert.equal((await app.inject({ url: '/api/auth/identity', headers: recipientHeaders })).json().registered, true);
    assert.equal((await app.inject({ url: '/api/requests', headers: recipientHeaders })).json().requests[0].viewerRole, 'creator');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM registration_consents').get()!.total, 2);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: recipientHeaders, payload: {} });
    assert.equal((await app.inject({ url: '/api/auth/identity', headers: recipientHeaders })).json(), null);
    assert.equal((await app.inject({ url: '/api/invitation', headers: recipientHeaders })).statusCode, 401);
  } finally { await app.close(); store.close(); }
});

test('X login rate limits persist in SQLite and disabled modes cannot accept X credentials', async () => {
  const s = setup();
  try {
    for (let attempt = 0; attempt < 30; attempt++) s.start();
    const restarted = new XAuth(s.auth, s.fixture.provider);
    assert.throws(() => restarted.start('127.0.0.1', undefined, undefined), codeIs('AUTH_RATE_LIMIT'));
    s.advance(600_000);
    assert.ok(s.start().url);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS total FROM oauth_flows').get()!.total, 1);
    assert.throws(() => new AuthService(s.store).xLogin({ provider: 'x', subject: users.sender.id, name: 'fake', handle: 'fake' }, null), codeIs('AUTH_DISABLED'));
    await assert.rejects(() => buildApp(new CommissionService(s.store), { demoAuth: true, xProvider: s.fixture.provider }), /cannot be enabled together/);
  } finally { s.store.close(); }
});
