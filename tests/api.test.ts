import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

test('HTTPでセッションと送信元を確認し、依頼リンクの入力を検証する', async () => {
  const store = new Store();
  const service = new RequestService(store);
  const app = await buildApp(service, { demoAuth: true });
  try {
    assert.equal((await app.inject('/api/demo/session')).json(), null);
    assert.equal(
      (await app.inject('/api/request-settings')).json().limits.maximumAmount,
      service.policy.maximumAmount,
    );
    assert.equal((await app.inject('/api/requests')).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/api/health', headers: { host: 'attacker.example' } })).statusCode,
      403,
    );
    const payload = { role: 'client' };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/demo/session', payload })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo/session',
          payload,
          headers: { 'x-favor-action': '1', origin: 'https://attacker.example' },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      payload,
      headers: { 'x-favor-action': '1' },
    });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.equal(
      (await app.inject({ url: '/api/demo/session', headers: { cookie } })).json().name,
      '青葉 / aoba',
    );
    const headers = { cookie, 'x-favor-action': '1', 'idempotency-key': randomUUID() };
    const body = {
      brief: '星を題材にした物語をお願いします。',
      amount: 12000,
      visibility: 'hidden',
      agreeToRules: true,
    };
    for (const invalid of [
      { ...body, amount: 1.5 },
      { ...body, brief: '' },
      { ...body, agreeToRules: false },
      { ...body, visibility: 'invalid' },
      { ...body, unexpectedField: true },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/links',
        payload: invalid,
        headers,
      });
      assert.equal(response.statusCode, 400);
    }
    const post = () => app.inject({ method: 'POST', url: '/api/links', payload: body, headers });
    const responses = await Promise.all([post(), post()]);
    assert.equal(responses[0]!.statusCode, 201);
    assert.equal(responses[1]!.json().link.id, responses[0]!.json().link.id);
    const { token, link } = responses[0]!.json();
    const proof = { 'x-favor-link': token };
    for (const method of ['GET', 'HEAD'] as const) {
      assert.equal(
        (await app.inject({ method, url: '/api/links/by-token', headers: proof })).statusCode,
        200,
      );
    }
    assert.equal(
      (await app.inject({ url: '/api/links/by-token', headers: proof })).json().state,
      'pending',
    );
    const key = randomUUID();
    const declines = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: '/api/links/by-token/decline',
          payload: {},
          headers: { ...headers, ...proof, 'idempotency-key': key },
        }),
      ),
    );
    for (const response of declines) assert.equal(response.statusCode, 200);
    const links = (await app.inject({ url: '/api/links', headers: { cookie } })).json().links;
    assert.equal(links[0].id, link.id);
    assert.equal(links[0].paymentState, 'released');
  } finally {
    await app.close();
    store.close();
  }
});
