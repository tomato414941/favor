import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { LocalAuth } from '../src/server/local-auth.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { InvitationService } from '../src/server/invitations.js';
import { buildApp } from '../src/server/app.js';
import type { RequestLinkInput } from '../src/shared.js';

const key = () => randomUUID();
const input: RequestLinkInput = { brief: '非公開の夜空の物語をお願いします。', amount: 12000, visibility: 'anonymous', nsfw: false, agreeToRules: true };
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function setup(mock: ConstructorParameters<typeof CommissionService>[3] = {}) {
  let now = 1_800_000_000_000;
  const store = new Store();
  const clock = () => now;
  const service = new CommissionService(store, clock, {}, mock);
  const auth = new AuthService(store, clock, { allowDemo: true, allowLocal: true });
  const links = new InvitationService(service, auth);
  const recipientSession = auth.demoLogin('recipient');
  const recipient = auth.identity(recipientSession).account;
  const other = auth.identity(auth.demoLogin('other')).account;
  return { store, auth, service, links, recipient, recipientSession, other, advance: (ms: number) => { now += ms; } };
}

test('秘密のリンクから登録前に依頼内容と金額を確認する', () => {
  const s = setup();
  try {
    const created = s.links.createLink('demo-client', key(), input);
    const view = s.links.readLink(created.token!);
    assert.equal(view.brief, input.brief);
    assert.equal(view.amount, input.amount);
    assert.equal(view.clientName, '匿名の依頼者');
    assert.equal(view.paymentState, 'authorized');
    assert.equal(s.auth.identity(s.recipientSession).registered, false);
    assert.throws(() => s.links.readLink(created.invitation.id), errorCode('LINK_UNAVAILABLE'));
    assert.throws(() => s.links.readLink('A'.repeat(43)), errorCode('LINK_UNAVAILABLE'));
    assert.equal(s.links.listLinks('demo-client')[0]!.id, created.invitation.id);
  } finally { s.store.close(); }
});

test('最初の受諾者に依頼をひも付けて再試行と納品を許可する', () => {
  const s = setup();
  try {
    const created = s.links.createLink('demo-client', key(), input);
    const operation = key();
    s.advance(3_600_000);
    const accepted = s.links.acceptLink(s.recipient, created.token!, operation, true);
    const actor = s.auth.actor(s.recipientSession);
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.paymentState, 'captured');
    assert.equal(accepted.recipientName, s.recipient.name);
    assert.equal(s.links.acceptLink(s.recipient, created.token!, operation, true).requestId, accepted.requestId);
    assert.equal(s.links.readLink(created.token!, s.recipient).requestId, accepted.requestId);
    assert.throws(() => s.links.acceptLink(s.other, created.token!, key(), true), errorCode('LINK_UNAVAILABLE'));
    assert.throws(() => s.links.readLink(created.token!), errorCode('LINK_UNAVAILABLE'));
    assert.throws(() => s.links.readLink(created.token!, s.other), errorCode('LINK_UNAVAILABLE'));
    const request = s.service.get(actor, accepted.requestId!);
    assert.equal(request.createdAt, created.invitation.createdAt);
    assert.equal(request.deliverBy, created.invitation.deliverBy);
    const delivered = s.service.deliver(actor, request.id, key(), [{ name: '物語.txt', content: Buffer.from('星の物語').toString('base64') }]);
    assert.equal(Buffer.from(s.service.download('demo-client', delivered.files[0]!.id).data).toString(), '星の物語');
    assert.equal(s.service.list('demo-client').length, 1);
    assert.equal(s.links.listLinks('demo-client')[0]!.paymentState, 'captured');
    assert.deepEqual(s.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { s.store.close(); }
});

test('同意と依頼者以外のアカウントを確認して受諾する', () => {
  const s = setup();
  try {
    const created = s.links.createLink('demo-client', key(), input);
    assert.throws(() => s.links.acceptLink(s.recipient, created.token!, key(), false), errorCode('RULES_REQUIRED'));
    const sender = s.auth.identity(s.auth.demoLogin('client')).account;
    assert.throws(() => s.links.acceptLink(sender, created.token!, key(), true), errorCode('FORBIDDEN'));
    assert.equal(s.links.readLink(created.token!).state, 'pending');
    assert.equal(s.links.acceptLink(s.recipient, created.token!, key(), true).state, 'accepted');
  } finally { s.store.close(); }
});

test('作成の再試行をまとめ、リンクを再発行して古いリンクを失効する', () => {
  const s = setup();
  try {
    const operation = key();
    const created = s.links.createLink('demo-client', operation, input);
    assert.equal(s.links.createLink('demo-client', operation, input).invitation.id, created.invitation.id);
    assert.throws(() => s.links.createLink('demo-client', operation, { ...input, amount: 13000 }), errorCode('KEY_REUSED'));
    s.advance(1000);
    const updated = s.links.reissueLink('demo-client', created.invitation.id, key());
    assert.equal(updated.invitation.expiresAt, created.invitation.expiresAt);
    assert.equal(updated.invitation.deliverBy, created.invitation.deliverBy);
    assert.throws(() => s.links.readLink(created.token!), errorCode('LINK_UNAVAILABLE'));
    assert.equal(s.links.readLink(updated.token!).id, created.invitation.id);
    assert.throws(() => s.links.reissueLink('other-client', created.invitation.id, key()), errorCode('INVITATION_UNAVAILABLE'));
    for (let i = 0; i < 4; i++) s.links.reissueLink('demo-client', created.invitation.id, key());
    assert.throws(() => s.links.reissueLink('demo-client', created.invitation.id, key()), errorCode('REISSUE_LIMIT'));
    assert.equal(s.links.listLinks('demo-client').length, 1);
  } finally { s.store.close(); }
});

test('登録せずに辞退し、取消・期限切れでも支払確保を解除する', () => {
  const s = setup();
  try {
    const declined = s.links.createLink('demo-client', key(), input);
    const operation = key();
    assert.deepEqual(s.links.declineLink(declined.token!, operation), { ok: true });
    assert.deepEqual(s.links.declineLink(declined.token!, operation), { ok: true });
    assert.throws(() => s.links.readLink(declined.token!), errorCode('LINK_UNAVAILABLE'));
    const withdrawn = s.links.createLink('demo-client', key(), input);
    assert.equal(s.links.withdrawLink('demo-client', withdrawn.invitation.id, key()).paymentState, 'released');
    assert.throws(() => s.links.readLink(withdrawn.token!), errorCode('LINK_UNAVAILABLE'));
    const expired = s.links.createLink('demo-client', key(), input);
    s.advance(7 * 86_400_000);
    assert.throws(() => s.links.acceptLink(s.recipient, expired.token!, key(), true), errorCode('LINK_UNAVAILABLE'));
    assert.ok(s.links.listLinks('demo-client').every((link) => link.paymentState === 'released'));
    assert.equal(s.auth.identity(s.auth.demoLogin('recipient')).registered, false);
  } finally { s.store.close(); }
});

test('支払確定の失敗時は受諾前に戻し、成功時に一度だけ移行する', () => {
  const mock = { failCapture: true };
  const s = setup(mock);
  try {
    const created = s.links.createLink('demo-client', key(), input);
    const operation = key();
    assert.throws(() => s.links.acceptLink(s.recipient, created.token!, operation, true), errorCode('PAYMENT_DECLINED'));
    assert.equal(s.links.readLink(created.token!).paymentState, 'authorized');
    assert.equal(s.auth.identity(s.recipientSession).registered, false);
    mock.failCapture = false;
    assert.equal(s.links.acceptLink(s.recipient, created.token!, operation, true).paymentState, 'captured');
  } finally { s.store.close(); }
});

test('支払確認中の依頼を期限切れにし、遅い決済通知を返金する', () => {
  const s = setup({ deferCardCapture: true });
  try {
    const created = s.links.createLink('demo-client', key(), input);
    const accepted = s.links.acceptLink(s.recipient, created.token!, key(), true);
    const actor = s.auth.actor(s.recipientSession);
    assert.equal(s.service.get(actor, accepted.requestId!).state, 'accepting');
    assert.throws(() => s.service.deliver(actor, accepted.requestId!, key(), [{ name: 'test.txt', content: 'YQ==' }]), errorCode('INVALID_STATE'));
    s.advance(7 * 86_400_000);
    s.service.completeMockCapture(accepted.requestId!, key());
    assert.equal(s.service.get(actor, accepted.requestId!).state, 'cancelled');
    assert.equal(s.links.readLink(created.token!, s.recipient).paymentState, 'refunded');
  } finally { s.store.close(); }
});

test('宛先未指定の依頼にも作成件数の制限を適用する', () => {
  const s = setup();
  try {
    for (let i = 0; i < 5; i++) s.links.createLink('demo-client', key(), input);
    assert.throws(() => s.links.createLink('demo-client', key(), input), errorCode('INVITATION_LIMIT'));
    for (const link of s.links.listLinks('demo-client')) s.links.withdrawLink('demo-client', link.id, key());
    for (let i = 0; i < 5; i++) {
      const link = s.links.createLink('demo-client', key(), input);
      s.links.withdrawLink('demo-client', link.invitation.id, key());
    }
    assert.throws(() => s.links.createLink('demo-client', key(), input), errorCode('INVITATION_LIMIT'));
  } finally { s.store.close(); }
});

test('既存DBを開き直して宛先指定済み招待の本人確認を維持する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-link-migration-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    const auth = new AuthService(store, Date.now, { allowDemo: true });
    const recipient = auth.identity(auth.demoLogin('recipient')).account;
    const legacy = new InvitationService(new CommissionService(store), auth).create('demo-client', key(), { ...input, recipientHandle: '@mio_demo' }, recipient);
    store.db.exec('ALTER TABLE invitations DROP COLUMN access_mode');
    store.close(); store = new Store(path);
    const links = new InvitationService(new CommissionService(store), new AuthService(store, Date.now, { allowDemo: true }));
    assert.equal(links.read(recipient, legacy.token!).brief, input.brief);
    assert.throws(() => links.readLink(legacy.token!), errorCode('LINK_UNAVAILABLE'));
    const created = links.createLink('demo-client', key(), input);
    assert.equal(links.readLink(created.token!).brief, input.brief);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('HTTPで未登録閲覧・受諾の競合・納品ファイルの権限を確認する', async () => {
  const store = new Store();
  const app = await buildApp(new CommissionService(store), { localAuth: true });
  const headers = { 'x-commission-action': '1' };
  const register = async (login: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/local/register', headers, payload: { login, password: 'long-password-for-test', name: login, agreeToRules: true } });
    assert.equal(response.statusCode, 200);
    return String(response.headers['set-cookie']).split(';')[0]!;
  };
  try {
    const sender = await register('link_sender');
    const created = await app.inject({ method: 'POST', url: '/api/links', payload: input, headers: { ...headers, cookie: sender, 'idempotency-key': key() } });
    assert.equal(created.statusCode, 201);
    const { token, link } = created.json();
    const proof = { 'x-commission-link': token };
    const read = await app.inject({ url: '/api/link', headers: proof });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().brief, input.brief);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.headers['referrer-policy'], 'no-referrer');
    assert.equal((await app.inject(`/api/link?token=${token}`)).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/link/accept', payload: { agreeToRules: true }, headers: { ...proof, ...headers, 'idempotency-key': key() } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/link/decline', headers: proof })).statusCode, 403);
    const first = await register('link_recipient'); const other = await register('link_other');
    const operation = key();
    const accept = (cookie: string) => app.inject({ method: 'POST', url: '/api/link/accept', payload: { agreeToRules: true }, headers: { ...headers, ...proof, cookie, 'idempotency-key': operation } });
    const results = await Promise.all([accept(first), accept(other)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404]);
    const winner = results[0]!.statusCode === 200 ? first : other;
    const accepted = results.find((r) => r.statusCode === 200)!.json();
    assert.equal((await accept(winner)).json().requestId, accepted.requestId);
    assert.equal((await app.inject({ url: '/api/link', headers: proof })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/links', headers: { cookie: sender } })).json().links[0].id, link.id);
    const delivery = await app.inject({ method: 'POST', url: `/api/requests/${accepted.requestId}/deliver`, payload: { files: [{ name: 'work.txt', content: 'YQ==' }] }, headers: { ...headers, cookie: winner, 'idempotency-key': key() } });
    assert.equal(delivery.statusCode, 200);
    assert.equal((await app.inject({ url: `/api/files/${delivery.json().files[0].id}`, headers: { cookie: sender } })).body, 'a');
    assert.equal((await app.inject({ url: `/api/files/${delivery.json().files[0].id}`, headers: proof })).statusCode, 401);
  } finally { await app.close(); store.close(); }
});

test('アカウントを再起動後も使い、ログイン・ログアウト・セッション期限を確認する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-local-auth-'));
  const path = join(directory, 'test.sqlite');
  let now = 1_800_000_000_000;
  let store = new Store(path);
  const clock = () => now;
  try {
    let auth = new AuthService(store, clock, { allowLocal: true });
    let local = new LocalAuth(auth);
    const input = { login: ' Aoba_ID ', password: 'correct-horse-battery', name: '青葉', agreeToRules: true };
    const token = await local.register(input);
    const user = auth.actor(token);
    assert.equal(auth.identity(token).account.handle, 'aoba_id');
    store.close(); store = new Store(path);
    auth = new AuthService(store, clock, { allowLocal: true }); local = new LocalAuth(auth);
    assert.equal(auth.actor(token), user);
    await assert.rejects(local.login({ login: 'aoba_id', password: 'incorrect-password' }), errorCode('UNAUTHORIZED'));
    assert.equal(auth.actor(token), user);
    const rotated = await local.login(input, token);
    assert.equal(auth.actor(rotated), user);
    assert.throws(() => auth.actor(token), errorCode('UNAUTHORIZED'));
    auth.logout(rotated);
    assert.throws(() => auth.actor(rotated), errorCode('UNAUTHORIZED'));
    const next = await local.login(input);
    now += 86_400_000;
    assert.throws(() => auth.actor(next), errorCode('UNAUTHORIZED'));
    await assert.rejects(local.register(input), errorCode('LOGIN_TAKEN'));
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('登録の入力・同意とログイン試行の上限を検証する', async () => {
  const s = setup();
  const local = new LocalAuth(s.auth);
  const account = { login: 'recipient', password: 'long-password-for-test', name: '澪', agreeToRules: true };
  try {
    await assert.rejects(local.register({ ...account, agreeToRules: false }), errorCode('RULES_REQUIRED'));
    await assert.rejects(local.register({ ...account, password: 'short' }), errorCode('INVALID_PASSWORD'));
    await assert.rejects(local.register({ ...account, login: 'bad/login' }), errorCode('INVALID_LOGIN'));
    const registered = await local.register(account);
    assert.equal(s.auth.identity(registered).registered, true);
    for (let i = 0; i < 10; i++) await assert.rejects(local.login({ ...account, password: 'wrong-password-1234' }), errorCode('UNAUTHORIZED'));
    await assert.rejects(local.login(account), errorCode('AUTH_RATE_LIMIT'));
    s.advance(600_000);
    assert.equal(s.auth.actor(await local.login(account)), s.auth.actor(registered));
  } finally { s.store.close(); }
});
