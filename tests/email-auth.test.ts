import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/server/auth.js';
import { EmailAuth } from '../src/server/email-auth.js';
import { Mailbox } from './mailbox.js';
import { buildApp } from '../src/server/app.js';
import { DomainError } from '../src/server/service.js';
import { CommissionService } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { Store } from '../src/server/store.js';

const input = {
  brief: '創作の依頼内容です。',
  amount: 12000,
  visibility: 'public' as const,
  nsfw: false,
  agreeToRules: true,
};
test('メールアドレスを本人だけに表示し、依頼相手と公開作品には公開用の名前を表示する', async () => {
  const store = new Store();
  const service = new CommissionService(store);
  const auth = new AuthService(store, Date.now, { allowEmail: true });
  const mailbox = new Mailbox();
  const links = new RequestLinkService(service, auth);
  try {
    const sender = await mailbox.login(auth, 'Sender+Art@Example.test');
    const receiver = await mailbox.login(auth, 'receiver@example.test');
    const senderIdentity = auth.identity(sender);
    const receiverIdentity = auth.identity(receiver);
    assert.equal(senderIdentity.email, 'sender+art@example.test');
    assert.equal(receiverIdentity.email, 'receiver@example.test');
    assert.match(senderIdentity.account.name, /^ユーザー [a-f0-9]{8}$/);
    assert.notEqual(senderIdentity.account.name, receiverIdentity.account.name);
    const created = links.create(auth.actor(sender), randomUUID(), input);
    const shared = links.read(created.token!);
    assert.equal(shared.clientName, senderIdentity.account.name);
    const accepted = links.accept(receiverIdentity.account, created.token!, randomUUID(), true);
    const request = service.get(auth.actor(sender), accepted.requestId!);
    assert.equal(request.clientName, senderIdentity.account.name);
    assert.equal(request.creatorName, receiverIdentity.account.name);
    service.deliver(auth.actor(receiver), request.id, randomUUID(), [
      { name: '作品.txt', content: Buffer.from('完成した作品').toString('base64') },
    ]);
    const publicWork = service.publicWorks().find((item) => item.id === request.id)!;
    assert.equal(publicWork.clientName, senderIdentity.account.name);
    assert.equal(publicWork.creatorName, receiverIdentity.account.name);
    for (const email of [senderIdentity.email!, receiverIdentity.email!]) {
      assert.equal(JSON.stringify([shared, accepted, request, publicWork]).includes(email), false);
    }
  } finally {
    store.close();
  }
});

const errorCode = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;
function setupEmail() {
  let now = 1_800_000_000_000;
  const store = new Store();
  const auth = new AuthService(store, () => now, { allowEmail: true });
  const mailbox = new Mailbox();
  const flow = new EmailAuth(auth, mailbox.deliver);
  return {
    store,
    auth,
    mailbox,
    flow,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('メールの確認コードを一度だけ使って本人のセッションを作成する', async () => {
  const s = setupEmail();
  try {
    const challenge = await s.flow.start(' Sender+Art@Example.test ');
    assert.equal(s.mailbox.messages[0]!.to, 'sender+art@example.test');
    assert.match(s.mailbox.messages[0]!.code, /^\d{8}$/);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0);
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
    const code = s.mailbox.code('sender+art@example.test');
    assert.throws(() => s.flow.verify(undefined, code), errorCode('INVALID_CODE'));
    assert.throws(() => s.flow.verify(challenge, 'invalid'), errorCode('INVALID_CODE'));
    const token = s.flow.verify(challenge, code);
    assert.equal(s.auth.identity(token).email, 'sender+art@example.test');
    assert.equal(s.auth.identity(token).registered, true);
    assert.throws(() => s.flow.verify(challenge, code), errorCode('INVALID_CODE'));
    const next = await s.mailbox.login(s.auth, 'sender+art@example.test', token);
    assert.equal(s.auth.identity(next).email, 'sender+art@example.test');
    assert.throws(() => s.auth.identity(token), errorCode('UNAUTHORIZED'));
    assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1);
  } finally {
    s.store.close();
  }
});

test('確認コードを10分で失効させ、5回の誤入力後は再送を求める', async () => {
  const s = setupEmail();
  try {
    const expired = await s.flow.start('expired@example.test');
    s.advance(600_000);
    assert.throws(
      () => s.flow.verify(expired, s.mailbox.code('expired@example.test')),
      errorCode('INVALID_CODE'),
    );
    const challenge = await s.flow.start('attempts@example.test');
    const code = s.mailbox.code('attempts@example.test');
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++)
      assert.throws(() => s.flow.verify(challenge, wrong), errorCode('INVALID_CODE'));
    assert.throws(() => s.flow.verify(challenge, code), errorCode('INVALID_CODE'));
    const resent = await s.flow.start('attempts@example.test', challenge);
    assert.equal(
      s.auth.identity(s.flow.verify(resent, s.mailbox.code('attempts@example.test'))).email,
      'attempts@example.test',
    );
  } finally {
    s.store.close();
  }
});

test('再送した確認コードを使い、メールの送信回数を制限する', async () => {
  const s = setupEmail();
  try {
    const first = await s.flow.start('resend@example.test');
    const oldCode = s.mailbox.code('resend@example.test');
    const second = await s.flow.start('resend@example.test', first);
    assert.throws(() => s.flow.verify(first, oldCode), errorCode('INVALID_CODE'));
    assert.equal(
      s.auth.identity(s.flow.verify(second, s.mailbox.code('resend@example.test'))).email,
      'resend@example.test',
    );
    await s.flow.start('resend@example.test');
    await assert.rejects(s.flow.start(' RESEND@example.test '), errorCode('AUTH_RATE_LIMIT'));
    s.advance(600_000);
    await s.flow.start('resend@example.test');
    assert.equal(s.mailbox.messages.length, 4);
  } finally {
    s.store.close();
  }
});

test('メール送信が失敗しても以前の確認コードとログイン状態を維持する', async () => {
  const s = setupEmail();
  try {
    const original = await s.mailbox.login(s.auth, 'current@example.test');
    const challenge = await s.flow.start('new@example.test');
    const code = s.mailbox.code('new@example.test');
    const unavailable = new EmailAuth(s.auth, async () => {
      throw new Error('Provider unavailable');
    });
    await assert.rejects(
      unavailable.start('new@example.test', challenge),
      errorCode('EMAIL_UNAVAILABLE'),
    );
    assert.equal(s.auth.identity(original).email, 'current@example.test');
    assert.equal(s.auth.identity(s.flow.verify(challenge, code)).email, 'new@example.test');
  } finally {
    s.store.close();
  }
});

test('メールアドレスの形式を確認してから送信する', async () => {
  const s = setupEmail();
  try {
    for (const email of [
      'not-an-email',
      'two@@example.test',
      '.leading@example.test',
      'two..dots@example.test',
      'a@-example.test',
      'a@example-.test',
      'a@local',
      'a\nb@example.test',
      `${'a'.repeat(65)}@example.test`,
      `a@${'a'.repeat(64)}.test`,
    ])
      await assert.rejects(s.flow.start(email), errorCode('INVALID_EMAIL'));
    await s.flow.start('valid+art@example.test');
    assert.equal(s.mailbox.messages.length, 1);
  } finally {
    s.store.close();
  }
});

test('確認コードを要求したブラウザでのみログインし、メール受信前の操作を拒否する', async () => {
  const s = setupEmail();
  const app = await buildApp(new CommissionService(s.store), { emailDelivery: s.mailbox.deliver });
  const headers = { 'x-commission-action': '1' };
  try {
    const started = await app.inject({
      method: 'POST',
      url: '/api/auth/email/start',
      headers,
      payload: { email: 'browser@example.test' },
    });
    assert.deepEqual(started.json(), { ok: true });
    const flowCookie = started.cookies.find((c) => c.name === 'commission_email')!;
    const cookie = `${flowCookie.name}=${flowCookie.value}`;
    assert.equal(flowCookie.httpOnly, true);
    assert.equal(flowCookie.sameSite, 'Strict');
    assert.equal(
      (await app.inject({ url: '/api/auth/identity', headers: { cookie } })).json(),
      null,
    );
    const verify = (cookie?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/email/verify',
        headers: { ...headers, ...(cookie ? { cookie } : {}) },
        payload: { code: s.mailbox.code('browser@example.test') },
      });
    assert.equal((await verify()).statusCode, 401);
    const verified = await verify(cookie);
    assert.equal(verified.statusCode, 200);
    const session = verified.cookies.find((c) => c.name === 'commission_session')!;
    assert.equal(
      (
        await app.inject({
          url: '/api/auth/identity',
          headers: { cookie: `${session.name}=${session.value}` },
        })
      ).json().email,
      'browser@example.test',
    );
    assert.equal((await verify(cookie)).statusCode, 401);
  } finally {
    await app.close();
    s.store.close();
  }
});

test('ログアウトすると進行中のメール確認を終了する', async () => {
  const s = setupEmail();
  const app = await buildApp(new CommissionService(s.store), { emailDelivery: s.mailbox.deliver });
  const headers = { 'x-commission-action': '1' };
  try {
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/email/start',
      headers,
      payload: { email: 'cancel@example.test' },
    });
    const flow = start.cookies[0]!;
    const cookie = `${flow.name}=${flow.value}`;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { ...headers, cookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/email/verify',
          headers: { ...headers, cookie },
          payload: { code: s.mailbox.code('cancel@example.test') },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    s.store.close();
  }
});
