import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { serve } from './http.js';

test('HTTPでセッションと送信元を確認し、依頼リンクの入力を検証する', async () => {
  const store = new Store();
  const service = new RequestService(store);
  const app = await serve(service);
  try {
    assert.equal(await (await app.request('/api/auth/identity')).json(), null);
    assert.equal((await app.request('/api/requests')).status, 401);
    assert.equal((await app.request('http://attacker.example/api/health')).status, 403);
    const form = { email: 'aoba@example.test', stay: '1' };
    // Page actions from another origin are refused by the router itself.
    assert.equal(
      (await app.request('/login', { form, headers: { origin: 'https://attacker.example' } }))
        .status,
      400,
    );
    assert.equal(
      (await app.request('/login', { form, headers: { 'sec-fetch-site': 'cross-site' } })).status,
      403,
    );
    const login = await app.request('/login', { form, headers: { origin: 'http://localhost' } });
    assert.equal(login.status, 200);
    assert.match(String(login.headers.get('set-cookie')), /HttpOnly/);
    assert.match(String(login.headers.get('set-cookie')), /SameSite=Strict/);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0]!;
    assert.equal(
      (await (await app.request('/api/auth/identity', { cookie })).json()).email,
      'aoba@example.test',
    );
    const compose = await app.request('/me/new', { cookie });
    assert.equal(compose.status, 200);
    assert.match(await compose.text(), new RegExp(`max="${service.policy.maximumAmount}"`));
    // Machine clients must state their intent; browsers are recognised by origin.
    assert.equal((await app.request('/api/links', { cookie, json: {} })).status, 403);
    const headers = { 'x-favor-action': '1', 'idempotency-key': randomUUID() };
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
      assert.equal(
        (await app.request('/api/links', { cookie, headers, json: invalid })).status,
        400,
      );
    }
    const post = () => app.request('/api/links', { cookie, headers, json: body });
    const responses = await Promise.all([post(), post()]);
    assert.equal(responses[0]!.status, 201);
    const first = await responses[0]!.json();
    assert.equal((await responses[1]!.json()).link.id, first.link.id);
    const { token, link } = first;
    const proof = { 'x-favor-link': token };
    for (const method of ['GET', 'HEAD'] as const) {
      assert.equal(
        (await app.request('/api/links/by-token', { method, headers: proof })).status,
        200,
      );
    }
    assert.equal(
      (await (await app.request('/api/links/by-token', { headers: proof })).json()).state,
      'pending',
    );
    // Declining twice with the same key is one decision.
    const key = randomUUID();
    const declines = await Promise.all(
      [1, 2].map(() => app.request('/link', { form: { intent: 'decline', token, key } })),
    );
    for (const response of declines) assert.equal(response.status, 200);
    const links = (await (await app.request('/api/links', { cookie })).json()).links;
    assert.equal(links[0].id, link.id);
    assert.equal(links[0].paymentState, 'released');
  } finally {
    await app.close();
    store.close();
  }
});
