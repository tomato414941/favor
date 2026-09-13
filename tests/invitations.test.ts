import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvitationInput, SocialAccount } from '../src/shared.js';
import { AuthService, hashToken } from '../src/server/auth.js';
import { buildApp } from '../src/server/app.js';
import { InvitationService } from '../src/server/invitations.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

const input: InvitationInput = { recipientHandle: '@mio_demo', brief: '未公開の物語をお願いします。', amount: 12000,
  visibility: 'anonymous', nsfw: true, agreeToRules: true };
const key = () => randomUUID();
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function setup(options: ConstructorParameters<typeof CommissionService>[3] = {}) {
  let now = 1_800_000_000_000;
  const store = new Store();
  const clock = () => now;
  const commissions = new CommissionService(store, clock, {}, options);
  const auth = new AuthService(store, clock, { allowDemo: true });
  const invitations = new InvitationService(commissions, auth);
  const recipient = auth.resolveDemoRecipient('@mio_demo');
  const create = (overrides: Partial<InvitationInput> = {}, target: SocialAccount = recipient, actor = 'demo-client') => invitations.create(actor, key(), { ...input, ...overrides }, target);
  return { store, commissions, auth, invitations, recipient, create, advance: (ms: number) => { now += ms; } };
}

test('invitation: provider subject protects private data and hashes are stored instead of raw links', () => {
  const s = setup();
  try {
    const created = s.create();
    assert.match(created.token!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(s.store.db.prepare('SELECT token_hash FROM invitations').get()!.token_hash, hashToken(created.token!));
    assert.equal(JSON.stringify(s.store.db.prepare('SELECT * FROM invitations').all()).includes(created.token!), false);
    assert.deepEqual(s.commissions.publicWorks(), []);
    assert.deepEqual(s.commissions.list('demo-client'), []);
    const other = s.auth.identity(s.auth.demoLogin('other')).account;
    assert.throws(() => s.invitations.read(other, created.token!), errorCode('INVITATION_UNAVAILABLE'));
    // Matching a display name or handle is not ownership of the provider subject.
    assert.throws(() => s.invitations.read({ ...other, handle: s.recipient.handle, name: s.recipient.name }, created.token!), errorCode('INVITATION_UNAVAILABLE'));
    assert.throws(() => s.invitations.read({ ...s.recipient, provider: 'different-provider' }, created.token!), errorCode('INVITATION_UNAVAILABLE'));
    assert.throws(() => s.invitations.accept(other, created.token!, key(), true), errorCode('INVITATION_UNAVAILABLE'));
    assert.throws(() => s.invitations.decline(other, created.token!, key()), errorCode('INVITATION_UNAVAILABLE'));
    assert.throws(() => s.invitations.reissue('other-client', created.invitation.id, key()), errorCode('INVITATION_UNAVAILABLE'));
    const session = s.auth.demoLogin('recipient');
    const identity = s.auth.identity(session);
    assert.equal(identity.registered, false);
    const view = s.invitations.read({ ...identity.account, handle: 'renamed' }, created.token!);
    assert.equal(view.brief, input.brief);
    assert.equal(view.clientName, '匿名の依頼者');
    assert.equal(view.amount, input.amount);
    assert.equal(view.paymentState, 'authorized');
    assert.equal(s.auth.identity(session).registered, false);
    assert.equal(Number(s.store.db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count), 4);
  } finally { s.store.close(); }
});

test('invitation: registration, hold transfer and acceptance are atomic and idempotent', () => {
  const s = setup();
  try {
    const created = s.create();
    s.advance(86_400_000);
    const session = s.auth.demoLogin('recipient');
    const account = s.auth.identity(session).account;
    const operationKey = key();
    assert.throws(() => s.invitations.accept(account, created.token!, operationKey, false), errorCode('RULES_REQUIRED'));
    assert.equal(s.auth.identity(session).registered, false);
    const accepted = s.invitations.accept(account, created.token!, operationKey, true);
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.paymentState, 'captured');
    assert.equal(s.invitations.accept(account, created.token!, operationKey, true).requestId, accepted.requestId);
    assert.throws(() => s.invitations.accept(account, created.token!, key(), true), errorCode('INVITATION_CLOSED'));
    assert.equal(s.auth.identity(session).registered, true);
    const actor = s.auth.actor(session);
    const request = s.commissions.get(actor, accepted.requestId!);
    assert.equal(request.createdAt, created.invitation.createdAt);
    assert.equal(request.acceptBy, created.invitation.expiresAt);
    assert.equal(request.deliverBy, created.invitation.deliverBy);
    assert.equal(request.clientName, '匿名の依頼者');
    assert.equal(s.commissions.list('demo-client').length, 1);
    assert.equal(Number(s.store.db.prepare("SELECT COUNT(*) AS count FROM effects WHERE operation = 'capture'").get()!.count), 1);
    const delivered = s.commissions.deliver(actor, request.id, key(), [{ name: '物語.txt', content: Buffer.from('完成した物語。').toString('base64') }]);
    assert.equal(s.commissions.download('demo-client', delivered.files[0]!.id).name, '物語.txt');
    assert.throws(() => s.commissions.download('other-client', delivered.files[0]!.id), errorCode('NOT_FOUND'));
    // A creator can also request work using the same account.
    assert.equal(s.commissions.create(actor, key(), { ...input, creatorId: 'demo-creator', paymentMethod: 'card' }).state, 'awaiting_acceptance');
    assert.deepEqual(s.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { s.store.close(); }
});

test('invitation: failed capture rolls back registration and leaves the original hold intact', () => {
  const s = setup({ failCapture: true });
  try {
    const created = s.create();
    const session = s.auth.demoLogin('recipient');
    assert.throws(() => s.invitations.accept(s.auth.identity(session).account, created.token!, key(), true), errorCode('PAYMENT_DECLINED'));
    assert.equal(s.auth.identity(session).registered, false);
    assert.equal(s.invitations.read(s.recipient, created.token!).state, 'pending');
    assert.equal(s.invitations.read(s.recipient, created.token!).paymentState, 'authorized');
    assert.equal(s.commissions.list('demo-client').length, 0);
    assert.equal(Number(s.store.db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count), 4);
    assert.equal(Number(s.store.db.prepare('SELECT COUNT(*) AS count FROM payments').get()!.count), 0);
    assert.equal(Number(s.store.db.prepare('SELECT COUNT(*) AS count FROM effects').get()!.count), 0);
  } finally { s.store.close(); }
});

test('invitation: pending capture never grants delivery and late payment cannot revive expiry', () => {
  const s = setup({ deferCardCapture: true });
  try {
    const created = s.create();
    const session = s.auth.demoLogin('recipient');
    const accepted = s.invitations.accept(s.recipient, created.token!, key(), true);
    const actor = s.auth.actor(session);
    assert.equal(s.commissions.get(actor, accepted.requestId!).state, 'accepting');
    assert.throws(() => s.commissions.deliver(actor, accepted.requestId!, key(), [{ name: 'work.txt', content: 'YQ==' }]), errorCode('INVALID_STATE'));
    s.advance(7 * 86_400_000);
    s.commissions.completeMockCapture(accepted.requestId!, key());
    assert.equal(s.commissions.get(actor, accepted.requestId!).state, 'cancelled');
    assert.equal(s.invitations.read(s.recipient, created.token!).paymentState, 'refunded');
  } finally { s.store.close(); }
});

test('invitation: reissue revokes old links, never extends time, and retry cannot create a second hold', () => {
  const s = setup();
  try {
    const operationKey = key();
    const created = s.invitations.create('demo-client', operationKey, input, s.recipient);
    const retried = s.invitations.create('demo-client', operationKey, input, s.recipient);
    assert.equal(retried.invitation.id, created.invitation.id);
    assert.equal(retried.token, undefined);
    assert.throws(() => s.invitations.create('demo-client', operationKey, { ...input, amount: 14000 }, s.recipient), errorCode('KEY_REUSED'));
    s.advance(1000);
    const reissueKey = key();
    const reissued = s.invitations.reissue('demo-client', created.invitation.id, reissueKey);
    assert.notEqual(reissued.token, created.token);
    assert.equal(reissued.invitation.expiresAt, created.invitation.expiresAt);
    assert.equal(reissued.invitation.deliverBy, created.invitation.deliverBy);
    assert.throws(() => s.invitations.read(s.recipient, created.token!), errorCode('INVITATION_UNAVAILABLE'));
    assert.equal(s.invitations.read(s.recipient, reissued.token!).brief, input.brief);
    assert.equal(s.invitations.reissue('demo-client', created.invitation.id, reissueKey).token, undefined);
    assert.equal(Number(s.store.db.prepare("SELECT COUNT(*) AS count FROM invitation_events WHERE action = 'authorize'").get()!.count), 1);
    for (let index = 0; index < 4; index++) s.invitations.reissue('demo-client', created.invitation.id, key());
    assert.throws(() => s.invitations.reissue('demo-client', created.invitation.id, key()), errorCode('REISSUE_LIMIT'));
    const revoked = s.invitations.withdraw('demo-client', created.invitation.id, key());
    assert.equal(revoked.paymentState, 'released');
    assert.throws(() => s.invitations.read(s.recipient, reissued.token!), errorCode('INVITATION_UNAVAILABLE'));
  } finally { s.store.close(); }
});

test('invitation: expiry and refusal release holds without registration; opt-out rejects future invitations', () => {
  const s = setup();
  try {
    const first = s.create();
    const session = s.auth.demoLogin('recipient');
    const declined = s.invitations.decline(s.recipient, first.token!, key());
    assert.equal(declined.cancelledReason, 'declined');
    assert.equal(declined.paymentState, 'released');
    assert.equal(s.auth.identity(session).registered, false);
    assert.throws(() => s.create(), errorCode('DUPLICATE_INVITATION'));
    s.advance(86_400_000);
    const second = s.create();
    const third = s.create({}, s.recipient, 'other-client');
    s.invitations.setPreference(s.recipient, true);
    assert.equal(s.invitations.read(s.recipient, second.token!).cancelledReason, 'recipient_blocked');
    assert.equal(s.invitations.read(s.recipient, third.token!).paymentState, 'released');
    assert.throws(() => s.create(), errorCode('INVITATIONS_DISABLED'));
    assert.equal(s.auth.identity(s.auth.demoLogin('recipient')).registered, false);
    s.invitations.setPreference(s.recipient, false);
    s.advance(86_400_000);
    const expiring = s.create();
    s.advance(7 * 86_400_000);
    assert.equal(s.invitations.expire(), 1);
    assert.equal(s.invitations.expire(), 0);
    assert.throws(() => s.invitations.read(s.recipient, expiring.token!), errorCode('INVITATION_UNAVAILABLE'));
    assert.throws(() => s.invitations.accept(s.recipient, expiring.token!, key(), true), errorCode('INVITATION_UNAVAILABLE'));
    const view = s.invitations.list('demo-client').find((invitation) => invitation.id === expiring.invitation.id)!;
    assert.equal(view.cancelledReason, 'expired');
    assert.equal(view.paymentState, 'released');
  } finally { s.store.close(); }
});

test('invitation: pending and daily limits cannot be bypassed by cancellation', () => {
  const s = setup();
  try {
    const made = [];
    for (let index = 0; index < 5; index++) made.push(s.create({}, { ...s.recipient, subject: `recipient-${index}` }));
    assert.throws(() => s.create(), errorCode('INVITATION_LIMIT'));
    for (const invitation of made) s.invitations.withdraw('demo-client', invitation.invitation.id, key());
    for (let index = 5; index < 10; index++) {
      const invitation = s.create({}, { ...s.recipient, subject: `recipient-${index}` });
      s.invitations.withdraw('demo-client', invitation.invitation.id, key());
    }
    assert.throws(() => s.create(), errorCode('INVITATION_LIMIT'));
  } finally { s.store.close(); }
});

test('session: persistent opaque tokens, expiry, logout, and nested rollback preserve existing data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-invitation-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  let now = 1_800_000_000_000;
  const clock = () => now;
  try {
    let auth = new AuthService(store, clock, { allowDemo: true });
    const token = auth.demoLogin('client');
    assert.equal(store.db.prepare('SELECT token_hash FROM sessions').get()!.token_hash, hashToken(token));
    const commissions = new CommissionService(store, clock);
    const invitations = new InvitationService(commissions, auth);
    const created = invitations.create('demo-client', key(), input, auth.resolveDemoRecipient('@mio_demo'));
    store.close(); store = new Store(path); auth = new AuthService(store, clock, { allowDemo: true });
    assert.equal(auth.actor(token), 'demo-client');
    assert.equal(new InvitationService(new CommissionService(store, clock), auth).list('demo-client')[0]!.id, created.invitation.id);
    assert.throws(() => store.transaction(() => {
      store.transaction(() => store.db.prepare("UPDATE users SET name = 'changed' WHERE id = 'demo-client'").run());
      throw new Error('rollback');
    }));
    assert.equal(store.db.prepare("SELECT name FROM users WHERE id = 'demo-client'").get()!.name, '青葉 / aoba');
    auth.logout(token);
    assert.throws(() => auth.actor(token), errorCode('UNAUTHORIZED'));
    const next = auth.demoLogin('client');
    now += 86_400_000;
    assert.throws(() => auth.actor(next), errorCode('UNAUTHORIZED'));
    assert.throws(() => auth.actor('demo-client'), errorCode('UNAUTHORIZED'));
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('HTTP invitation: anonymous, wrong-account, scanner, forged identity, CSRF and revoked-link protection', async () => {
  const store = new Store(); const service = new CommissionService(store);
  const app = await buildApp(service, { demoAuth: true });
  const headers = { 'x-commission-action': '1' };
  const login = async (path: string, payload: Record<string, string>) => {
    const response = await app.inject({ method: 'POST', url: path, payload, headers });
    assert.equal(response.statusCode, 200);
    return String(response.headers['set-cookie']).split(';')[0]!;
  };
  try {
    const sender = await login('/api/demo/session', { role: 'client' });
    const created = await app.inject({ method: 'POST', url: '/api/invitations', payload: input, headers: { ...headers, cookie: sender, 'idempotency-key': key() } });
    assert.equal(created.statusCode, 201);
    const { token, invitation } = created.json();
    const proofHeaders = { 'x-commission-invitation': token };
    assert.equal((await app.inject({ url: '/api/invitation', headers: proofHeaders })).statusCode, 401);
    const wrong = await login('/api/demo/identity', { persona: 'other' });
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url: '/api/invitation', headers: { ...proofHeaders, cookie: wrong } });
      assert.equal(response.statusCode, 404);
      assert.equal(response.body.includes(input.brief), false);
      assert.equal(response.body.includes(String(input.amount)), false);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/demo/identity', payload: { persona: 'social-mio', subject: 'social-mio' }, headers })).statusCode, 400);
    const forged = await app.inject({ method: 'POST', url: '/api/demo/identity', payload: { persona: 'other', subject: 'social-mio', name: '澪 / mio' }, headers });
    assert.equal(forged.statusCode, 200);
    assert.equal(forged.json().account.subject, 'social-sora');
    assert.equal((await app.inject({ url: '/api/invitation', headers: { ...proofHeaders, cookie: String(forged.headers['set-cookie']).split(';')[0]! } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/invitation/accept', payload: { agreeToRules: true }, headers: { ...headers, ...proofHeaders, cookie: wrong, 'idempotency-key': key() } })).statusCode, 404);
    const recipient = await login('/api/demo/identity', { persona: 'recipient' });
    const authorized = { ...proofHeaders, cookie: recipient };
    const read = await app.inject({ url: '/api/invitation', headers: authorized });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().clientName, '匿名の依頼者');
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.headers['referrer-policy'], 'no-referrer');
    assert.equal((await app.inject({ url: '/api/auth/identity', headers: { cookie: recipient } })).json().registered, false);
    assert.equal((await app.inject({ url: '/api/invitation/accept', headers: authorized })).statusCode, 404);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM requests').get()!.count), 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/invitation/accept', payload: { agreeToRules: true }, headers: authorized })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/invitation-preference', payload: { blocked: true }, headers })).statusCode, 401);
    const rotated = await app.inject({ method: 'POST', url: `/api/invitations/${invitation.id}/reissue`, headers: { ...headers, cookie: sender, 'idempotency-key': key() } });
    assert.equal(rotated.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/invitation', headers: authorized })).statusCode, 404);
    const acceptance = { ...headers, cookie: recipient, 'x-commission-invitation': rotated.json().token, 'idempotency-key': key() };
    const [one, two] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/invitation/accept', payload: { agreeToRules: true }, headers: acceptance })));
    assert.equal(one!.statusCode, 200);
    assert.equal(two!.json().requestId, one!.json().requestId);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM requests').get()!.count), 1);
    assert.equal((await app.inject({ url: '/api/session', headers: { cookie: recipient } })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie: recipient } });
    assert.equal((await app.inject({ url: '/api/invitation', headers: acceptance })).statusCode, 401);
  } finally { await app.close(); store.close(); }
});

test('HTTP: demo authentication and demo recipient lookup are absent unless explicitly enabled', async () => {
  const store = new Store();
  const demoAuth = new AuthService(store, Date.now, { allowDemo: true });
  const priorDemoToken = demoAuth.demoLogin('client');
  const app = await buildApp(new CommissionService(store));
  try {
    for (const path of ['/api/demo/session', '/api/demo/identity', '/api/invitations']) {
      assert.equal((await app.inject({ method: 'POST', url: path, payload: {}, headers: { 'x-commission-action': '1' } })).statusCode, 404);
    }
    assert.equal((await app.inject('/api/demo/session')).statusCode, 404);
    assert.equal((await app.inject('/api/health')).json().demoAuth, false);
    assert.equal((await app.inject({ url: '/api/session', headers: { cookie: 'commission_session=demo-client' } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/session', headers: { cookie: `commission_session=${priorDemoToken}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/auth/identity', headers: { cookie: `commission_session=${priorDemoToken}` } })).json(), null);
    assert.throws(() => new AuthService(store).demoLogin('client'), errorCode('DEMO_DISABLED'));
  } finally { await app.close(); store.close(); }
});
