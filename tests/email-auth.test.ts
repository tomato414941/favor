import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthService } from '../src/server/auth.js';
import { LocalAuth } from '../src/server/local-auth.js';
import { buildApp } from '../src/server/app.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { InvitationService } from '../src/server/invitations.js';
import { Store } from '../src/server/store.js';

const password = 'private-email-test-password';
const input = { brief: '以前からの依頼内容です。', amount: 12000, visibility: 'public' as const, nsfw: false, agreeToRules: true };
const isError = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

function legacyAccount(store: Store) {
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  store.db.prepare('INSERT INTO users (id, name, role, points) VALUES (?, ?, ?, 0)').run('legacy-user', '青葉', 'client');
  store.db.prepare('INSERT INTO social_accounts (provider, subject, handle, name, user_id) VALUES (?, ?, ?, ?, ?)').run('local', 'legacy-subject', 'old_aoba', '青葉', 'legacy-user');
  store.db.prepare('INSERT INTO local_credentials (login, subject, salt, password_hash) VALUES (?, ?, ?, ?)').run('old_aoba', 'legacy-subject', salt, hash);
}

test('メールアドレスを本人だけに表示し、依頼相手と公開作品には公開用の名前を表示する', async () => {
  const store = new Store();
  const service = new CommissionService(store);
  const auth = new AuthService(store, Date.now, { allowLocal: true });
  const local = new LocalAuth(auth);
  const links = new InvitationService(service, auth);
  try {
    const sender = await local.register({ email: 'Sender+Art@Example.test', password, agreeToRules: true });
    const receiver = await local.register({ email: 'receiver@example.test', password, agreeToRules: true });
    const senderIdentity = auth.identity(sender);
    const receiverIdentity = auth.identity(receiver);
    assert.equal(senderIdentity.email, 'sender+art@example.test');
    assert.equal(receiverIdentity.email, 'receiver@example.test');
    assert.match(senderIdentity.account.name, /^ユーザー [a-f0-9]{8}$/);
    assert.notEqual(senderIdentity.account.name, receiverIdentity.account.name);
    const created = links.createLink(auth.actor(sender), randomUUID(), input);
    const shared = links.readLink(created.token!);
    assert.equal(shared.clientName, senderIdentity.account.name);
    const accepted = links.acceptLink(receiverIdentity.account, created.token!, randomUUID(), true);
    const request = service.get(auth.actor(sender), accepted.requestId!);
    assert.equal(request.clientName, senderIdentity.account.name);
    assert.equal(request.creatorName, receiverIdentity.account.name);
    service.deliver(auth.actor(receiver), request.id, randomUUID(), [{ name: '作品.txt', content: Buffer.from('完成した作品').toString('base64') }]);
    const publicWork = service.publicWorks().find((item) => item.id === request.id)!;
    assert.equal(publicWork.clientName, senderIdentity.account.name);
    assert.equal(publicWork.creatorName, receiverIdentity.account.name);
    for (const email of [senderIdentity.email!, receiverIdentity.email!]) {
      assert.equal(JSON.stringify([shared, accepted, request, publicWork]).includes(email), false);
    }
  } finally { store.close(); }
});

test('以前のログインIDからメールアドレスへ切り替え、再起動後も同じ依頼を管理する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-email-migration-'));
  const path = join(directory, 'commission.sqlite');
  let store = new Store(path);
  const service = new CommissionService(store);
  const auth = new AuthService(store, Date.now, { allowLocal: true });
  legacyAccount(store);
  const oldSession = auth.localSession('legacy-subject');
  const request = service.create('legacy-user', randomUUID(), { ...input, creatorId: 'demo-creator', paymentMethod: 'card' });
  const link = new InvitationService(service, auth).createLink('legacy-user', randomUUID(), input);
  const app = await buildApp(service, { localAuth: true });
  const headers = { 'x-commission-action': '1', cookie: `commission_session=${oldSession}` };
  try {
    const migrated = await app.inject({ method: 'POST', url: '/api/auth/local/migrate', headers,
      payload: { login: ' OLD_AOBA ', email: ' Migrated@Example.test ', password } });
    assert.equal(migrated.statusCode, 200);
    assert.equal(migrated.json().email, 'migrated@example.test');
    assert.equal(migrated.json().account.name, '青葉');
    assert.equal(migrated.json().registered, true);
    const cookie = String(migrated.headers['set-cookie']).split(';')[0]!;
    const requests = await app.inject({ url: '/api/requests', headers: { cookie } });
    assert.equal(requests.json().requests[0].id, request.id);
    const links = await app.inject({ url: '/api/links', headers: { cookie } });
    assert.equal(links.json().links[0].id, link.invitation.id);
    assert.equal((await app.inject({ url: '/api/auth/identity', headers })).json(), null);
    await app.close();
    store.close();
    store = new Store(path);
    const reopened = new AuthService(store, Date.now, { allowLocal: true });
    const session = await new LocalAuth(reopened).login({ email: 'MIGRATED@example.test', password });
    assert.equal(reopened.actor(session), 'legacy-user');
    assert.equal(new CommissionService(store).get(reopened.actor(session), request.id).brief, input.brief);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('切り替え時に以前のパスワードとメールアドレスの重複を確認し、元の依頼の所有者を維持する', async () => {
  const store = new Store();
  const auth = new AuthService(store, Date.now, { allowLocal: true });
  const local = new LocalAuth(auth);
  legacyAccount(store);
  const previous = auth.localSession('legacy-subject');
  const credentials = { login: 'old_aoba', email: 'next@example.test', password };
  try {
    const existing = await local.register({ email: 'taken@example.test', password, agreeToRules: true });
    await assert.rejects(local.migrate({ ...credentials, password: 'incorrect-password' }, previous), isError('UNAUTHORIZED'));
    await assert.rejects(local.migrate({ ...credentials, email: 'TAKEN@example.test' }, previous), isError('EMAIL_TAKEN'));
    assert.equal(auth.actor(previous), 'legacy-user');
    assert.equal(auth.actor(await local.login({ email: 'taken@example.test', password })), auth.actor(existing));
    const attempts = await Promise.allSettled([
      local.migrate(credentials, previous),
      local.migrate({ ...credentials, email: 'another@example.test' }, previous),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const migrated = attempts.find((attempt) => attempt.status === 'fulfilled')!;
    assert.equal(auth.actor(migrated.value), 'legacy-user');
    const currentEmail = auth.identity(migrated.value).email!;
    assert.equal(auth.actor(await local.login({ email: currentEmail, password })), 'legacy-user');
    assert.equal(auth.actor(await local.login({ email: 'taken@example.test', password })), auth.actor(existing));
  } finally { store.close(); }
});
