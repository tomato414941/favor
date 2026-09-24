import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { buildApp } from '../src/server/app.js';
import { Mailbox } from './mailbox.js';

const key = () => randomUUID();
const codeIs = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.code === code;
const input = {
  brief: 'メールで届ける依頼です。',
  amount: 12000,
  visibility: 'anonymous' as const,
  agreeToRules: true,
  delivery: 'email' as const,
  recipientEmail: ' Maker@Example.test ',
};

async function setup() {
  const store = new Store();
  const mailbox = new Mailbox();
  const service = new RequestService(store);
  const auth = new AuthService(store, Date.now, { allowDemo: true });
  const links = new RequestLinkService(service, auth, mailbox.deliver);
  const sender = auth.identity(await mailbox.login(auth, 'client@example.test'));
  const senderId = auth.actor(await mailbox.login(auth, 'client@example.test'));
  const maker = auth.identity(await mailbox.login(auth, 'maker@example.test'));
  const other = auth.identity(await mailbox.login(auth, 'other@example.test'));
  return { store, mailbox, service, auth, links, sender, senderId, maker, other };
}

test('メールで届ける依頼は宛先へリンクを送り、送り主にはURLを返さず、宛先でログインした人だけが開ける', async () => {
  const s = await setup();
  try {
    const created = s.links.create(s.senderId, key(), input);
    assert.equal(created.link.delivery, 'email');
    assert.equal(created.link.recipientEmail, 'maker@example.test');
    await s.links.send(s.senderId, created.link.id, created.token!, 'https://favor.test', true);
    const mail = s.mailbox.messages.at(-1)!;
    assert.equal(mail.to, 'maker@example.test');
    assert.match(mail.subject, /依頼が届いています/);
    assert.match(mail.text, /^匿名の依頼者から/);
    assert.ok(mail.text.includes(`https://favor.test/link#${created.token}`));

    assert.throws(() => s.links.read(created.token!), codeIs('LINK_LOGIN_REQUIRED'));
    assert.throws(
      () => s.links.read(created.token!, s.other.account, s.other.email),
      codeIs('LINK_OTHER_RECIPIENT'),
    );
    const view = s.links.read(created.token!, s.maker.account, s.maker.email);
    assert.equal(view.clientName, '匿名の依頼者');
    assert.equal(view.recipientEmail, null);
    assert.throws(
      () => s.links.decline(created.token!, key(), s.other.account, s.other.email),
      codeIs('LINK_OTHER_RECIPIENT'),
    );
    assert.throws(
      () => s.links.accept(s.other.account, created.token!, key(), true, s.other.email),
      codeIs('LINK_OTHER_RECIPIENT'),
    );
    const accepted = s.links.accept(s.maker.account, created.token!, key(), true, s.maker.email);
    assert.equal(accepted.state, 'accepted');
    assert.equal(
      s.service.get(
        s.auth.actor(await s.mailbox.login(s.auth, 'maker@example.test')),
        accepted.requestId!,
      ).clientName,
      '匿名の依頼者',
    );
  } finally {
    s.store.close();
  }
});

test('匿名はメールで届ける場合にだけ選べ、宛先の形式と重複を確認する', async () => {
  const s = await setup();
  try {
    assert.throws(
      () => s.links.create(s.senderId, key(), { ...input, delivery: 'self' }),
      codeIs('INVALID_INPUT'),
    );
    assert.throws(
      () => s.links.create(s.senderId, key(), { ...input, recipientEmail: 'not-an-address' }),
      codeIs('INVALID_EMAIL'),
    );
    const first = s.links.create(s.senderId, key(), { ...input, visibility: 'public' });
    assert.equal(first.link.visibility, 'public');
    assert.throws(() => s.links.create(s.senderId, key(), input), codeIs('DUPLICATE_LINK'));
    const handed = s.links.create(s.senderId, key(), {
      ...input,
      visibility: 'hidden',
      delivery: 'self',
      recipientEmail: undefined,
    });
    assert.equal(handed.link.delivery, 'self');
    assert.equal(handed.link.recipientEmail, null);
    assert.equal(s.links.read(handed.token!).brief, input.brief);
  } finally {
    s.store.close();
  }
});

test('送信に失敗した初回の依頼は支払確保を解除し、再送の失敗は依頼を残す', async () => {
  const s = await setup();
  try {
    let failing = true;
    const links = new RequestLinkService(s.service, s.auth, async (message) => {
      if (failing) throw new Error('provider down');
      s.mailbox.messages.push(message);
    });
    const created = links.create(s.senderId, key(), input);
    await assert.rejects(
      links.send(s.senderId, created.link.id, created.token!, 'https://favor.test', true),
      codeIs('EMAIL_UNAVAILABLE'),
    );
    const cancelled = links.list(s.senderId)[0]!;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancelledReason, 'undeliverable');

    failing = false;
    const again = links.create(s.senderId, key(), input);
    await links.send(s.senderId, again.link.id, again.token!, 'https://favor.test', true);
    failing = true;
    const reissued = links.reissue(s.senderId, again.link.id, key());
    await assert.rejects(
      links.send(s.senderId, again.link.id, reissued.token!, 'https://favor.test', false),
      codeIs('EMAIL_UNAVAILABLE'),
    );
    assert.equal(
      links.list(s.senderId).find((item) => item.id === again.link.id)!.state,
      'pending',
    );
    assert.throws(
      () => links.read(again.token!, s.maker.account, s.maker.email),
      codeIs('LINK_UNAVAILABLE'),
    );
    assert.equal(links.read(reissued.token!, s.maker.account, s.maker.email).state, 'pending');
  } finally {
    s.store.close();
  }
});

test('受信拒否は受諾待ちのメール依頼を見送り、その宛先への新しい送信を止める', async () => {
  const s = await setup();
  try {
    const created = s.links.create(s.senderId, key(), input);
    assert.deepEqual(s.links.optout('maker@example.test'), { blocked: false });
    assert.deepEqual(s.links.setOptout('Maker@Example.test', true), { blocked: true });
    assert.equal(s.links.list(s.senderId)[0]!.cancelledReason, 'recipient_blocked');
    assert.throws(
      () => s.links.read(created.token!, s.maker.account, s.maker.email),
      codeIs('LINK_UNAVAILABLE'),
    );
    assert.throws(() => s.links.create(s.senderId, key(), input), codeIs('RECIPIENT_UNAVAILABLE'));
    assert.deepEqual(s.links.setOptout('maker@example.test', false), { blocked: false });
    assert.equal(s.links.create(s.senderId, key(), input).link.state, 'pending');
  } finally {
    s.store.close();
  }
});

test('HTTPでメール依頼を作成すると本文にリンクが入り、宛先以外には開けず、受信設定を切り替えられる', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const app = await buildApp(new RequestService(store), {
    demoAuth: true,
    emailDelivery: mailbox.deliver,
    publicOrigin: 'http://localhost:3210',
  });
  const headers = { host: 'localhost:3210', 'x-favor-action': '1' };
  const login = async (email: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/login',
      headers,
      payload: { email },
    });
    assert.equal(response.statusCode, 200);
    const session = response.cookies.find((cookie) => cookie.name.endsWith('favor_session'))!;
    return `${session.name}=${session.value}`;
  };
  try {
    const sender = await login('client@example.test');
    const created = await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...headers, cookie: sender, 'idempotency-key': key() },
      payload: input,
    });
    assert.equal(created.statusCode, 201);
    assert.equal('token' in created.json(), false);
    assert.equal(created.json().link.recipientEmail, 'maker@example.test');
    const mail = mailbox.messages.at(-1)!;
    const token = /link#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    const linkHeaders = { host: 'localhost:3210', 'x-favor-link': token };
    const anonymous = await app.inject({ url: '/api/links/by-token', headers: linkHeaders });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().code, 'LINK_LOGIN_REQUIRED');
    const other = await login('other@example.test');
    assert.equal(
      (await app.inject({ url: '/api/links/by-token', headers: { ...linkHeaders, cookie: other } }))
        .statusCode,
      403,
    );
    const maker = await login('maker@example.test');
    const read = await app.inject({
      url: '/api/links/by-token',
      headers: { ...linkHeaders, cookie: maker },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().clientName, '匿名の依頼者');
    assert.deepEqual(
      (
        await app.inject({ url: '/api/links/optout', headers: { ...headers, cookie: maker } })
      ).json(),
      { blocked: false },
    );
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/links/optout',
      headers: { ...headers, cookie: maker },
      payload: { blocked: true },
    });
    assert.deepEqual(blocked.json(), { blocked: true });
    assert.equal(
      (await app.inject({ url: '/api/links/by-token', headers: { ...linkHeaders, cookie: maker } }))
        .statusCode,
      404,
    );
    const refused = await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { ...headers, cookie: sender, 'idempotency-key': key() },
      payload: input,
    });
    assert.equal(refused.statusCode, 409);
  } finally {
    await app.close();
    store.close();
  }
});
