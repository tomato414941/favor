import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import {
  StripePayments,
  type CardPayment,
  type CardStatus,
  type PaymentProvider,
} from '../src/server/payment-provider.js';
import { serve } from './http.js';

const DAY = 86400000;
const input = {
  brief: '海辺の絵をお願いします。',
  amount: 12000,
  visibility: 'hidden' as const,
  agreeToRules: true,
};
const file = [{ name: 'art.txt', content: Buffer.from('完成した作品').toString('base64') }];
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;

class Cards implements PaymentProvider {
  readonly mode = 'stripe_test' as const;
  readonly signer = new StripePayments('rk_test_fixture', 'whsec_fixture');
  readonly states = new Map<string, CardStatus>();
  starts = 0;
  captures = 0;
  releases = 0;
  loseCaptureResponse = false;
  failRelease = false;
  failCapture = false;
  failCheckout = false;
  async checkout(payment: CardPayment) {
    if (this.failCheckout) throw new Error('checkout unavailable');
    if (!this.states.has(payment.link_id)) {
      this.starts++;
      this.states.set(payment.link_id, { state: 'pending', intentId: null, holdUntil: 0 });
    }
    return { id: `cs_test_${payment.link_id}`, url: 'https://checkout.stripe.com/c/pay/fixture' };
  }
  authorize(id: string, until: number) {
    this.states.set(id, { state: 'authorized', intentId: `pi_${id}`, holdUntil: until });
  }
  async inspect(payment: CardPayment) {
    return this.states.get(payment.link_id)!;
  }
  async capture(payment: CardPayment) {
    if (this.failCapture) throw new Error('capture unavailable');
    const current = await this.inspect(payment);
    if (current.state !== 'captured') {
      this.captures++;
      this.states.set(payment.link_id, { ...current, state: 'captured' });
    }
    if (this.loseCaptureResponse) {
      this.loseCaptureResponse = false;
      throw new Error('connection lost after capture');
    }
    return this.states.get(payment.link_id)!;
  }
  async release(payment: CardPayment) {
    if (this.failRelease) throw new Error('release unavailable');
    const current = await this.inspect(payment);
    if (current.state !== 'released') {
      this.releases++;
      this.states.set(payment.link_id, { ...current, state: 'released' });
    }
    return this.states.get(payment.link_id)!;
  }
  event(body: Buffer, signature: string) {
    return this.signer.event(body, signature);
  }
}

async function setup(path?: string, cards = new Cards()) {
  let now = Date.now();
  const store = new Store(path);
  const service = new RequestService(store, () => now, {}, cards);
  const auth = new AuthService(store, () => now, { allowDemo: true });
  const sender = auth.actor(auth.demoLogin('client'));
  const session = auth.demoLogin('creator');
  const recipient = auth.identity(session).account;
  const links = new RequestLinkService(service, auth);
  await service.recipients.onboard(recipient.subject, 'http://localhost');
  const create = () => links.create(sender, randomUUID(), input, 'https://favor.example');
  const authorize = async () => {
    const draft = await create();
    cards.authorize(draft.link.id, now + 7 * DAY);
    return links.complete(sender, draft.link.id, randomUUID());
  };
  return {
    store,
    service,
    auth,
    sender,
    recipient,
    links,
    cards,
    create,
    authorize,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('カード入力を再開し、金額の仮押さえを確認してから秘密のリンクを発行する', async () => {
  const s = await setup();
  try {
    const key = randomUUID();
    const [one, retry] = await Promise.all([
      s.links.create(s.sender, key, input),
      s.links.create(s.sender, key, input),
    ]);
    assert.equal(one.link.id, retry.link.id);
    assert.equal(s.cards.starts, 1);
    assert.equal(one.link.state, 'awaiting_payment');
    assert.equal(one.link.paymentState, 'pending');
    assert.equal(one.token, undefined);
    assert.equal((await s.links.checkout(s.sender, one.link.id)).checkoutUrl, one.checkoutUrl);
    await assert.rejects(
      s.links.complete(s.sender, one.link.id, randomUUID()),
      code('PAYMENT_PENDING'),
    );
    await assert.rejects(
      s.links.create(s.sender, key, { ...input, amount: 13000 }),
      code('KEY_REUSED'),
    );
    await assert.rejects(
      s.links.complete('somebody-else', one.link.id, randomUUID()),
      code('LINK_UNAVAILABLE'),
    );
    s.cards.authorize(one.link.id, s.now() + 7 * DAY);
    const paid = await s.links.complete(s.sender, one.link.id, randomUUID());
    assert.equal(paid.link.state, 'pending');
    assert.equal(paid.link.deliverBy, s.now() + 7 * DAY - 300000);
    assert.equal(s.links.read(paid.token!).amount, input.amount);
    assert.equal(
      s.store.db.prepare('SELECT token_hash FROM request_links WHERE id = ?').get(one.link.id)!
        .token_hash === paid.token,
      false,
    );
    const accepted = await s.links.accept(s.recipient, paid.token!, randomUUID(), true);
    assert.equal(accepted.paymentState, 'authorized');
    assert.equal(s.cards.captures, 0);
    const delivered = await s.service.deliver(
      'demo-creator',
      accepted.requestId!,
      randomUUID(),
      file,
    );
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.paymentState, 'captured');
    assert.equal(s.cards.captures, 1);
    assert.equal(
      Buffer.from(
        s.service.download(s.sender, delivered.id, delivered.files[0]!.id).data,
      ).toString(),
      '完成した作品',
    );
  } finally {
    s.store.close();
  }
});

test('支払確定の通信断から再起動後に復旧し、確定を確認したファイルを一度だけ公開する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-payment-'));
  const path = join(directory, 'app.sqlite');
  let s = await setup(path);
  let open = true;
  try {
    const paid = await s.authorize();
    const accepted = await s.links.accept(s.recipient, paid.token!, randomUUID(), true);
    const id = accepted.requestId!;
    s.cards.loseCaptureResponse = true;
    await assert.rejects(
      s.service.deliver('demo-creator', id, randomUUID(), file),
      /connection lost/,
    );
    assert.equal(s.service.get(s.sender, id).state, 'delivering');
    assert.deepEqual(s.service.get(s.sender, id).files, []);
    const staged = String(
      s.store.db.prepare('SELECT id FROM files WHERE request_id = ?').get(id)!.id,
    );
    assert.throws(() => s.service.download(s.sender, id, staged), code('NOT_FOUND'));
    assert.throws(() => s.service.publicWork(id), code('NOT_FOUND'));
    const cards = s.cards;
    s.store.close();
    open = false;
    s = await setup(path, cards);
    open = true;
    s.advance(10000);
    await s.service.payments.reconcile();
    const delivered = s.service.get(s.sender, id);
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.files.length, 1);
    assert.equal(cards.captures, 1);
    assert.equal(delivered.transferState, 'pending');
    await s.service.recipients.reconcile();
    assert.equal(s.service.get(s.sender, id).transferState, 'transferred');
    await s.service.payments.settle(paid.link.id);
    assert.equal(s.service.get(s.sender, id).deliveryVersion, 1);
  } finally {
    if (open) s.store.close();
    rmSync(directory, { recursive: true });
  }
});

test('解除の失敗を手続き中として保存し、再試行で仮押さえを解除する', async () => {
  const s = await setup();
  try {
    const paid = await s.authorize();
    s.cards.failRelease = true;
    const key = randomUUID();
    await assert.rejects(s.links.withdraw(s.sender, paid.link.id, key), /release unavailable/);
    assert.equal(s.links.get(s.sender, paid.link.id).state, 'cancelled');
    assert.equal(s.links.get(s.sender, paid.link.id).paymentState, 'releasing');
    s.cards.failRelease = false;
    s.advance(10000);
    await s.service.payments.reconcile();
    assert.equal(s.links.get(s.sender, paid.link.id).paymentState, 'released');
    await s.links.withdraw(s.sender, paid.link.id, key);
    assert.equal(s.cards.releases, 1);
  } finally {
    s.store.close();
  }
});

test('カード入力画面の準備に失敗した依頼を取り消して終了する', async () => {
  const s = await setup();
  try {
    s.cards.failCheckout = true;
    const key = randomUUID();
    await assert.rejects(s.links.create(s.sender, key, input), /checkout unavailable/);
    const [draft] = s.links.list(s.sender);
    const closed = await s.links.withdraw(s.sender, draft!.id, randomUUID());
    assert.equal(closed.state, 'cancelled');
    assert.equal(closed.paymentState, 'released');
    await assert.rejects(s.links.create(s.sender, key, input), code('LINK_CLOSED'));
  } finally {
    s.store.close();
  }
});

test('カード入力の放置と受諾後の納品期限切れで仮押さえを解除する', async () => {
  const s = await setup();
  try {
    const draft = await s.create();
    s.cards.authorize(draft.link.id, s.now() + 7 * DAY);
    s.advance(3600000);
    s.links.expire();
    await s.service.payments.reconcile();
    assert.equal(s.links.get(s.sender, draft.link.id).paymentState, 'released');
    const paid = await s.authorize();
    const accepted = await s.links.accept(s.recipient, paid.token!, randomUUID(), true);
    s.advance(accepted.deliverBy - s.now());
    s.service.expire();
    await s.service.payments.reconcile();
    assert.equal(s.service.get(s.sender, accepted.requestId!).paymentState, 'released');
    assert.equal(s.cards.captures, 0);
  } finally {
    s.store.close();
  }
});

test('決済通知の署名を検証し、重複や順不同の通知を現在のStripeの状態に合わせる', async () => {
  const s = await setup();
  const app = await serve(s.service);
  try {
    const draft = await s.create();
    const event = {
      id: 'evt_authorized',
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: `cs_test_${draft.link.id}`,
          object: 'checkout.session',
          metadata: { favor_link_id: draft.link.id },
        },
      },
    };
    const post = async (payload: string, signature: string) =>
      app.request('/api/payments/stripe-webhook', {
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
    const payload = JSON.stringify(event);
    assert.equal((await post(payload, 'invalid')).status, 400);
    s.cards.authorize(draft.link.id, s.now() + 7 * DAY);
    const signature = s.cards.signer.stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_fixture',
    });
    assert.equal((await post(payload + ' ', signature)).status, 400);
    for (let i = 0; i < 2; i++) assert.equal((await post(payload, signature)).status, 200);
    assert.equal(s.links.get(s.sender, draft.link.id).paymentState, 'authorized');
    await s.links.withdraw(s.sender, draft.link.id, randomUUID());
    const older = JSON.stringify({ ...event, id: 'evt_older' });
    const olderSignature = s.cards.signer.stripe.webhooks.generateTestHeaderString({
      payload: older,
      secret: 'whsec_fixture',
    });
    assert.equal((await post(older, olderSignature)).status, 200);
    assert.equal(s.links.get(s.sender, draft.link.id).paymentState, 'released');
    assert.equal(s.cards.releases, 1);
  } finally {
    await app.close();
    s.store.close();
  }
});
