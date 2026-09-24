import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { Mailbox } from './mailbox.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { buildApp } from '../src/server/app.js';
import type { RequestLinkInput } from '../src/shared.js';

const key = () => randomUUID();
const input: RequestLinkInput = {
  brief: '非公開の夜空の物語をお願いします。',
  amount: 12000,
  visibility: 'hidden',
  agreeToRules: true,
};
const errorCode = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;
function setup(mock: ConstructorParameters<typeof RequestService>[3] = {}) {
  let now = 1_800_000_000_000;
  const store = new Store();
  const clock = () => now;
  const service = new RequestService(store, clock, {}, mock);
  const auth = new AuthService(store, clock, { allowDemo: true });
  const links = new RequestLinkService(service, auth);
  auth.demoLogin('client');
  const recipientSession = auth.demoLogin('recipient');
  const recipient = auth.identity(recipientSession).account;
  const other = auth.identity(auth.demoLogin('other')).account;
  return {
    store,
    auth,
    service,
    links,
    recipient,
    recipientSession,
    other,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('秘密のリンクから登録前に依頼内容と金額を確認する', () => {
  const s = setup();
  try {
    const created = s.links.create('demo-client', key(), input);
    const view = s.links.read(created.token!);
    assert.equal(view.brief, input.brief);
    assert.equal(view.amount, input.amount);
    assert.equal(view.clientName, '青葉 / aoba');
    assert.equal(view.paymentState, 'authorized');
    assert.throws(() => s.links.read(created.link.id), errorCode('LINK_UNAVAILABLE'));
    assert.throws(() => s.links.read('A'.repeat(43)), errorCode('LINK_UNAVAILABLE'));
    assert.equal(s.links.list('demo-client')[0]!.id, created.link.id);
  } finally {
    s.store.close();
  }
});

test('最初の受諾者に依頼をひも付けて再試行と納品を許可する', () => {
  const s = setup();
  try {
    const created = s.links.create('demo-client', key(), input);
    const operation = key();
    s.advance(3_600_000);
    const accepted = s.links.accept(s.recipient, created.token!, operation, true);
    const actor = s.auth.actor(s.recipientSession);
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.paymentState, 'captured');
    assert.equal(accepted.recipientName, s.recipient.name);
    assert.equal(
      s.links.accept(s.recipient, created.token!, operation, true).requestId,
      accepted.requestId,
    );
    assert.equal(s.links.read(created.token!, s.recipient).requestId, accepted.requestId);
    assert.throws(
      () => s.links.accept(s.other, created.token!, key(), true),
      errorCode('LINK_UNAVAILABLE'),
    );
    assert.throws(() => s.links.read(created.token!), errorCode('LINK_UNAVAILABLE'));
    assert.throws(() => s.links.read(created.token!, s.other), errorCode('LINK_UNAVAILABLE'));
    const request = s.service.get(actor, accepted.requestId!);
    assert.equal(request.createdAt, created.link.createdAt);
    assert.equal(request.deliverBy, created.link.deliverBy);
    const delivered = s.service.deliver(actor, request.id, key(), [
      { name: '物語.txt', content: Buffer.from('星の物語').toString('base64') },
    ]);
    assert.equal(
      Buffer.from(
        s.service.download('demo-client', request.id, delivered.files[0]!.id).data,
      ).toString(),
      '星の物語',
    );
    assert.equal(s.service.list('demo-client').length, 1);
    assert.equal(s.links.list('demo-client')[0]!.paymentState, 'captured');
    assert.deepEqual(s.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    s.store.close();
  }
});

test('同意と依頼者以外のアカウントを確認して受諾する', () => {
  const s = setup();
  try {
    const created = s.links.create('demo-client', key(), input);
    assert.throws(
      () => s.links.accept(s.recipient, created.token!, key(), false),
      errorCode('RULES_REQUIRED'),
    );
    const sender = s.auth.identity(s.auth.demoLogin('client')).account;
    assert.throws(
      () => s.links.accept(sender, created.token!, key(), true),
      errorCode('FORBIDDEN'),
    );
    assert.equal(s.links.read(created.token!).state, 'pending');
    assert.equal(s.links.accept(s.recipient, created.token!, key(), true).state, 'accepted');
  } finally {
    s.store.close();
  }
});

test('作成の再試行をまとめ、リンクを再発行して古いリンクを失効する', () => {
  const s = setup();
  try {
    const operation = key();
    const created = s.links.create('demo-client', operation, input);
    assert.equal(s.links.create('demo-client', operation, input).link.id, created.link.id);
    assert.throws(
      () => s.links.create('demo-client', operation, { ...input, amount: 13000 }),
      errorCode('KEY_REUSED'),
    );
    s.advance(1000);
    const updated = s.links.reissue('demo-client', created.link.id, key());
    assert.equal(updated.link.expiresAt, created.link.expiresAt);
    assert.equal(updated.link.deliverBy, created.link.deliverBy);
    assert.throws(() => s.links.read(created.token!), errorCode('LINK_UNAVAILABLE'));
    assert.equal(s.links.read(updated.token!).id, created.link.id);
    assert.throws(
      () => s.links.reissue(s.auth.actor(s.auth.demoLogin('other')), created.link.id, key()),
      errorCode('LINK_UNAVAILABLE'),
    );
    for (let i = 0; i < 4; i++) s.links.reissue('demo-client', created.link.id, key());
    assert.throws(
      () => s.links.reissue('demo-client', created.link.id, key()),
      errorCode('REISSUE_LIMIT'),
    );
    assert.equal(s.links.list('demo-client').length, 1);
  } finally {
    s.store.close();
  }
});

test('登録せずに辞退し、取消・期限切れでも支払確保を解除する', () => {
  const s = setup();
  try {
    const declined = s.links.create('demo-client', key(), input);
    const operation = key();
    assert.deepEqual(s.links.decline(declined.token!, operation), { ok: true });
    assert.deepEqual(s.links.decline(declined.token!, operation), { ok: true });
    assert.throws(() => s.links.read(declined.token!), errorCode('LINK_UNAVAILABLE'));
    const withdrawn = s.links.create('demo-client', key(), input);
    assert.equal(
      s.links.withdraw('demo-client', withdrawn.link.id, key()).paymentState,
      'released',
    );
    assert.throws(() => s.links.read(withdrawn.token!), errorCode('LINK_UNAVAILABLE'));
    const expired = s.links.create('demo-client', key(), input);
    s.advance(7 * 86_400_000);
    assert.throws(
      () => s.links.accept(s.recipient, expired.token!, key(), true),
      errorCode('LINK_UNAVAILABLE'),
    );
    assert.ok(s.links.list('demo-client').every((link) => link.paymentState === 'released'));
  } finally {
    s.store.close();
  }
});

test('支払確定の失敗時は受諾前に戻し、成功時に一度だけ移行する', () => {
  const mock = { failCapture: true };
  const s = setup(mock);
  try {
    const created = s.links.create('demo-client', key(), input);
    const operation = key();
    assert.throws(
      () => s.links.accept(s.recipient, created.token!, operation, true),
      errorCode('PAYMENT_DECLINED'),
    );
    assert.equal(s.links.read(created.token!).paymentState, 'authorized');
    mock.failCapture = false;
    assert.equal(
      s.links.accept(s.recipient, created.token!, operation, true).paymentState,
      'captured',
    );
  } finally {
    s.store.close();
  }
});

test('支払確認中の依頼を期限切れにし、遅い決済通知を返金する', () => {
  const s = setup({ deferCardCapture: true });
  try {
    const created = s.links.create('demo-client', key(), input);
    const accepted = s.links.accept(s.recipient, created.token!, key(), true);
    const actor = s.auth.actor(s.recipientSession);
    assert.equal(s.service.get(actor, accepted.requestId!).state, 'accepting');
    assert.throws(
      () =>
        s.service.deliver(actor, accepted.requestId!, key(), [
          { name: 'test.txt', content: 'YQ==' },
        ]),
      errorCode('INVALID_STATE'),
    );
    s.advance(7 * 86_400_000);
    s.service.completeMockCapture(accepted.requestId!, key());
    assert.equal(s.service.get(actor, accepted.requestId!).state, 'cancelled');
    assert.equal(s.links.read(created.token!, s.recipient).paymentState, 'refunded');
  } finally {
    s.store.close();
  }
});

test('宛先未指定の依頼にも作成件数の制限を適用する', () => {
  const s = setup();
  try {
    for (let i = 0; i < 5; i++) s.links.create('demo-client', key(), input);
    assert.throws(() => s.links.create('demo-client', key(), input), errorCode('LINK_LIMIT'));
    for (const link of s.links.list('demo-client')) s.links.withdraw('demo-client', link.id, key());
    for (let i = 0; i < 5; i++) {
      const link = s.links.create('demo-client', key(), input);
      s.links.withdraw('demo-client', link.link.id, key());
    }
    assert.throws(() => s.links.create('demo-client', key(), input), errorCode('LINK_LIMIT'));
  } finally {
    s.store.close();
  }
});

test('HTTPで未登録閲覧・受諾の競合・納品ファイルの権限を確認する', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const app = await buildApp(new RequestService(store), {
    demoAuth: true,
    emailDelivery: mailbox.deliver,
  });
  const headers = { 'x-favor-action': '1' };
  const register = async (name: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/login',
      headers,
      payload: { email: `${name}@example.test` },
    });
    assert.equal(response.statusCode, 200);
    return `favor_session=${response.cookies.find((cookie) => cookie.name === 'favor_session')!.value}`;
  };
  try {
    const sender = await register('link_sender');
    const created = await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: input,
      headers: { ...headers, cookie: sender, 'idempotency-key': key() },
    });
    assert.equal(created.statusCode, 201);
    const { token, link } = created.json();
    const proof = { 'x-favor-link': token };
    const read = await app.inject({ url: '/api/links/by-token', headers: proof });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().brief, input.brief);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.headers['referrer-policy'], 'no-referrer');
    assert.equal((await app.inject(`/api/links/by-token?token=${token}`)).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/links/by-token/accept',
          payload: { agreeToRules: true },
          headers: { ...proof, ...headers, 'idempotency-key': key() },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/links/by-token/decline', headers: proof }))
        .statusCode,
      403,
    );
    const first = await register('link_recipient');
    const other = await register('link_other');
    const operation = key();
    const accept = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/links/by-token/accept',
        payload: { agreeToRules: true },
        headers: { ...headers, ...proof, cookie, 'idempotency-key': operation },
      });
    const results = await Promise.all([accept(first), accept(other)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 404]);
    const winner = results[0]!.statusCode === 200 ? first : other;
    const accepted = results.find((r) => r.statusCode === 200)!.json();
    assert.equal((await accept(winner)).json().requestId, accepted.requestId);
    assert.equal(
      (await app.inject({ url: '/api/links/by-token', headers: proof })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: '/api/links', headers: { cookie: sender } })).json().links[0].id,
      link.id,
    );
    const delivery = await app.inject({
      method: 'POST',
      url: `/api/requests/${accepted.requestId}/deliver`,
      payload: { files: [{ name: 'work.txt', content: 'YQ==' }] },
      headers: { ...headers, cookie: winner, 'idempotency-key': key() },
    });
    assert.equal(delivery.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          url: `/api/requests/${delivery.json().id}/files/${delivery.json().files[0].id}`,
          headers: { cookie: sender },
        })
      ).body,
      'a',
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/requests/${delivery.json().id}/files/${delivery.json().files[0].id}`,
          headers: proof,
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    store.close();
  }
});
