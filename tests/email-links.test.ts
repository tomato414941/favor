import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { Mailbox } from './mailbox.js';
import { serve } from './http.js';
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
  await service.recipients.onboard(maker.account.subject, 'http://localhost');
  const other = auth.identity(await mailbox.login(auth, 'other@example.test'));
  return { store, mailbox, service, auth, links, sender, senderId, maker, other };
}
test('メールで届ける依頼は宛先へリンクを送り、送り主にはURLを返さず、宛先でログインした人だけが開ける', async () => {
  const s = await setup();
  try {
    const created = await s.links.create(s.senderId, key(), input);
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
    await assert.rejects(
      async () => await s.links.decline(created.token!, key(), s.other.account, s.other.email),
      codeIs('LINK_OTHER_RECIPIENT'),
    );
    await assert.rejects(
      async () => await s.links.accept(s.other.account, created.token!, key(), true, s.other.email),
      codeIs('LINK_OTHER_RECIPIENT'),
    );
    const accepted = await s.links.accept(
      s.maker.account,
      created.token!,
      key(),
      true,
      s.maker.email,
    );
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
    await assert.rejects(
      async () => await s.links.create(s.senderId, key(), { ...input, delivery: 'self' }),
      codeIs('INVALID_INPUT'),
    );
    await assert.rejects(
      async () =>
        await s.links.create(s.senderId, key(), { ...input, recipientEmail: 'not-an-address' }),
      codeIs('INVALID_EMAIL'),
    );
    const first = await s.links.create(s.senderId, key(), { ...input, visibility: 'public' });
    assert.equal(first.link.visibility, 'public');
    await assert.rejects(
      async () => await s.links.create(s.senderId, key(), input),
      codeIs('DUPLICATE_LINK'),
    );
    const handed = await s.links.create(s.senderId, key(), {
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
    const created = await links.create(s.senderId, key(), input);
    await assert.rejects(
      links.send(s.senderId, created.link.id, created.token!, 'https://favor.test', true),
      codeIs('EMAIL_UNAVAILABLE'),
    );
    const cancelled = links.list(s.senderId)[0]!;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancelledReason, 'undeliverable');
    failing = false;
    const again = await links.create(s.senderId, key(), input);
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
    const created = await s.links.create(s.senderId, key(), input);
    assert.deepEqual(s.links.optout('maker@example.test'), { blocked: false });
    assert.deepEqual(await s.links.setOptout('Maker@Example.test', true), { blocked: true });
    assert.equal(s.links.list(s.senderId)[0]!.cancelledReason, 'recipient_blocked');
    assert.throws(
      () => s.links.read(created.token!, s.maker.account, s.maker.email),
      codeIs('LINK_UNAVAILABLE'),
    );
    await assert.rejects(
      async () => await s.links.create(s.senderId, key(), input),
      codeIs('RECIPIENT_UNAVAILABLE'),
    );
    assert.deepEqual(await s.links.setOptout('maker@example.test', false), { blocked: false });
    assert.equal((await s.links.create(s.senderId, key(), input)).link.state, 'pending');
  } finally {
    s.store.close();
  }
});
test('HTTPでメール依頼を作成すると本文にリンクが入り、宛先以外には開けず、受信設定を切り替えられる', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const app = await serve(new RequestService(store), {
    mail: mailbox.deliver,
    publicOrigin: 'http://localhost:3210',
  });
  const headers = { 'x-favor-action': '1' };
  try {
    const sender = await app.login('client@example.test');
    const created = await app.request('/api/links', {
      cookie: sender,
      headers: { ...headers, 'idempotency-key': key() },
      json: input,
    });
    assert.equal(created.status, 201);
    const result = await created.json();
    assert.equal('token' in result, false);
    assert.equal(result.link.recipientEmail, 'maker@example.test');
    const mail = mailbox.messages.at(-1)!;
    assert.ok(mail.text.includes('http://localhost:3210/link#'));
    const token = /link#([A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
    const proof = { 'x-favor-link': token };
    const anonymous = await app.request('/api/links/by-token', { headers: proof });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, 'LINK_LOGIN_REQUIRED');
    const other = await app.login('other@example.test');
    assert.equal(
      (await app.request('/api/links/by-token', { cookie: other, headers: proof })).status,
      403,
    );
    const maker = await app.login('maker@example.test');
    const read = await app.request('/api/links/by-token', { cookie: maker, headers: proof });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).clientName, '匿名の依頼者');
    const landing = await app.request('/link', { cookie: maker });
    assert.equal(landing.status, 200);
    assert.doesNotMatch(await landing.text(), /メールで届ける依頼です/);
    const blocked = await app.request('/link', {
      cookie: maker,
      form: { intent: 'optout', token, blocked: '1' },
    });
    assert.equal(blocked.status, 200);
    assert.deepEqual(app.favor.links.optout('maker@example.test'), { blocked: true });
    assert.equal(
      (await app.request('/api/links/by-token', { cookie: maker, headers: proof })).status,
      404,
    );
    const refused = await app.request('/api/links', {
      cookie: sender,
      headers: { ...headers, 'idempotency-key': key() },
      json: input,
    });
    assert.equal(refused.status, 409);
  } finally {
    await app.close();
    store.close();
  }
});
