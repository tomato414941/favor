import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.js';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { Mailbox } from './mailbox.js';

const publicOrigin = 'https://favor.example';
const headers = { host: 'favor.example', origin: publicOrigin, 'x-favor-action': '1' };

test('公開URLで登録・ログイン・ログアウトし、HTTPS専用のCookieと送信元の確認を適用する', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const app = await buildApp(new RequestService(store), {
    emailDelivery: mailbox.deliver,
    publicOrigin,
    trustLoopbackProxy: true,
  });
  const credentials = {
    email: 'public-recipient@example.test',
  };
  try {
    const loginByEmail = async () => {
      const started = await app.inject({
        method: 'POST',
        url: '/api/auth/email/start',
        headers,
        payload: credentials,
      });
      assert.equal(started.statusCode, 200);
      const flow = started.cookies.find((entry) => entry.name === '__Host-favor_email')!;
      assert.equal(flow.httpOnly, true);
      assert.equal(flow.secure, true);
      assert.equal(flow.sameSite, 'Strict');
      assert.equal(flow.path, '/');
      return app.inject({
        method: 'POST',
        url: '/api/auth/email/verify',
        headers: { ...headers, cookie: `${flow.name}=${flow.value}` },
        payload: { code: mailbox.code(credentials.email) },
      });
    };
    const registered = await loginByEmail();
    assert.equal(registered.statusCode, 200);
    const session = registered.cookies.find((entry) => entry.name === '__Host-favor_session')!;
    assert.equal(session.secure, true);
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Strict');
    assert.equal(session.path, '/');
    const cookie = `${session.name}=${session.value}`;
    const identity = await app.inject({
      url: '/api/auth/identity',
      headers: { ...headers, cookie },
    });
    assert.equal(identity.json().email, credentials.email);
    assert.equal(identity.headers['cache-control'], 'no-store');
    assert.equal(identity.headers['referrer-policy'], 'no-referrer');

    for (const changedHeaders of [
      { ...headers, host: 'elsewhere.example', 'x-forwarded-host': 'favor.example' },
      { ...headers, origin: 'https://elsewhere.example' },
      { ...headers, origin: 'http://favor.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/email/start',
            headers: changedHeaders,
            payload: credentials,
          })
        ).statusCode,
        403,
      );
    }
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, cookie },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(logout.cookies.find((entry) => entry.name === session.name)!.secure, true);
    assert.equal(
      (await app.inject({ url: '/api/auth/identity', headers: { ...headers, cookie } })).json(),
      null,
    );
    const login = await loginByEmail();
    assert.equal(login.statusCode, 200);
    assert.equal(
      login.cookies.find((entry) => entry.name === '__Host-favor_session')!.secure,
      true,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test('公開URLにHTTPSを要求し、固定アカウントの体験モードをループバックに限定する', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const service = new RequestService(store);
  try {
    for (const value of [
      'invalid',
      'http://favor.example',
      `${publicOrigin}/`,
      `${publicOrigin}/path`,
      'https://user:pass@favor.example',
    ]) {
      await assert.rejects(
        buildApp(service, { emailDelivery: mailbox.deliver, publicOrigin: value }),
        /FAVOR_PUBLIC_ORIGIN/,
      );
    }
    await assert.rejects(buildApp(service, { demoAuth: true, publicOrigin }), /only on loopback/);
    await assert.rejects(buildApp(service, { trustLoopbackProxy: true }), /FAVOR_PUBLIC_ORIGIN/);
    const app = await buildApp(service, { demoAuth: true, publicOrigin: 'http://127.0.0.1:3211' });
    try {
      assert.equal(
        (await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:3211' } })).statusCode,
        200,
      );
    } finally {
      await app.close();
    }
  } finally {
    store.close();
  }
});

test('同じ端末の認証試行を制限し、信頼するプロキシ経由の別端末には試行を許可する', async () => {
  const store = new Store();
  const mailbox = new Mailbox();
  const app = await buildApp(new RequestService(store), {
    emailDelivery: mailbox.deliver,
    publicOrigin,
    trustLoopbackProxy: true,
  });
  const attempt = (remoteAddress: string, forwarded: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/email/start',
      remoteAddress,
      headers: { ...headers, 'x-forwarded-for': forwarded },
      payload: { email: 'invalid-email' },
    });
  try {
    for (let i = 0; i < 30; i++)
      assert.equal((await attempt('127.0.0.1', '192.0.2.10')).statusCode, 400);
    assert.equal((await attempt('127.0.0.1', '192.0.2.10')).statusCode, 429);
    assert.equal((await attempt('127.0.0.1', '192.0.2.11')).statusCode, 400);
    for (let i = 0; i < 30; i++)
      assert.equal((await attempt('192.0.2.12', `198.51.100.${i + 1}`)).statusCode, 400);
    assert.equal((await attempt('192.0.2.12', '198.51.100.100')).statusCode, 429);
  } finally {
    await app.close();
    store.close();
  }
});
