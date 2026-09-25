import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Favor, configFromEnv } from '../src/server/favor.js';
import { StripePayments, type CardPayment } from '../src/server/payment-provider.js';
import { publicProfile } from '../src/server/public-profile.js';
import { Store } from '../src/server/store.js';

const profile = {
  businessType: 'individual' as const,
  email: 'support@example.test',
  contactHours: '平日10〜17時',
  discloseOnRequest: true,
};

test('本番決済は本番キーと確認済みのStripeアカウントを照合して開始する', async (t) => {
  assert.throws(
    () => new StripePayments('rk_test_fixture', 'whsec_fixture', {}, 'stripe_live'),
    /payment mode/,
  );
  assert.throws(() => new StripePayments('rk_live_fixture', 'whsec_fixture'), /payment mode/);
  const provider = new StripePayments('rk_live_fixture', 'whsec_fixture', {}, 'stripe_live');
  const account = { id: 'acct_favor', charges_enabled: false, payouts_enabled: false };
  t.mock.method(provider.stripe.accounts, 'retrieveCurrent', async () => ({ ...account }));
  for (const resource of [
    provider.stripe.refunds,
    provider.stripe.disputes,
    provider.stripe.transfers,
  ])
    t.mock.method(resource, 'list', async () => ({ data: [] }));
  await assert.rejects(provider.verifyAccount('acct_favor'), /not ready/);
  account.charges_enabled = true;
  await assert.rejects(provider.verifyAccount('acct_favor'), /not ready/);
  account.payouts_enabled = true;
  await assert.rejects(provider.verifyAccount('acct_other'), /does not match/);
  await provider.verifyAccount('acct_favor');
  t.mock.method(provider.stripe.disputes, 'list', async () => {
    throw new Error('Permission denied');
  });
  await assert.rejects(provider.verifyAccount('acct_favor'), /dispute read access/);
});

test('本番設定と公開情報をそろえて起動し、テスト環境への切替は別DBを要求する', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-live-config-'));
  t.after(() => rmSync(directory, { recursive: true }));
  t.mock.method(
    StripePayments.prototype,
    'verifyAccount',
    async function (this: StripePayments, expected: string) {
      assert.equal(this.mode, 'stripe_live');
      assert.equal(expected, 'acct_favor');
    },
  );
  const env = {
    NODE_ENV: 'test',
    FAVOR_PAYMENT_MODE: 'stripe_live',
    FAVOR_AUTH_MODE: 'clerk',
    FAVOR_DATA_DIR: directory,
    FAVOR_PUBLIC_ORIGIN: 'https://favor.example.test',
    CLERK_SECRET_KEY: 'sk_live_fixture',
    CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.example.test$').toString('base64')}`,
    STRIPE_API_KEY: 'rk_live_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_ACCOUNT_ID: 'acct_favor',
    FAVOR_MAIL_DELIVERY: 'resend',
    RESEND_API_KEY: 're_fixture',
    FAVOR_EMAIL_FROM: 'Favor <login@example.test>',
    FAVOR_PUBLIC_PROFILE: JSON.stringify(profile),
  };
  for (const patch of [
    { FAVOR_DATA_DIR: undefined },
    { FAVOR_PUBLIC_PROFILE: undefined },
    { FAVOR_AUTH_MODE: 'demo' },
    { CLERK_PUBLISHABLE_KEY: 'pk_test_fixture' },
    { CLERK_SECRET_KEY: 'sk_test_fixture' },
    { FAVOR_PUBLIC_ORIGIN: 'http://localhost' },
    { FAVOR_TEST_MAIL_DOMAIN: 'favor.test' },
  ])
    await assert.rejects(configFromEnv({ ...env, ...patch }), /Live payments require/);
  const config = await configFromEnv(env);
  const favor = new Favor(config);
  assert.equal(favor.service.payments.provider.mode, 'stripe_live');
  assert.equal(favor.service.recipients.provider.mode, 'stripe_live');
  assert.equal(favor.publicProfile?.businessType, 'individual');
  favor.close();
  await assert.rejects(
    configFromEnv({
      NODE_ENV: 'test',
      FAVOR_DATA_DIR: directory,
      FAVOR_AUTH_MODE: 'demo',
      FAVOR_PAYMENT_MODE: 'mock',
      FAVOR_MAIL_DELIVERY: 'file',
    }),
    /different payment or authentication environment/,
  );
});

test('既存DBを決済モード・Stripeアカウント・認証環境に固定して再開する', () => {
  const store = new Store();
  try {
    store.bindInstance('stripe_test', 'acct_test', 'pk_test_fixture');
    store.bindInstance('stripe_test', 'acct_test', 'pk_test_fixture');
    for (const [mode, account, auth] of [
      ['stripe_live', 'acct_test', 'pk_test_fixture'],
      ['stripe_test', 'acct_other', 'pk_test_fixture'],
      ['stripe_test', 'acct_test', 'pk_live_fixture'],
    ])
      assert.throws(
        () => store.bindInstance(mode!, account!, auth!),
        /different payment or authentication environment/,
      );
  } finally {
    store.close();
  }
});

test('環境が未設定の利用者データを本番で開く場合は新しいDBを要求する', () => {
  const store = new Store();
  try {
    store.db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('fixture', 'Fixture');
    assert.throws(
      () => store.bindInstance('stripe_live', 'acct_live', 'pk_live_fixture'),
      /new database/,
    );
  } finally {
    store.close();
  }
});

test('公開情報は事業形態と開示方法に応じて必要事項を検証する', () => {
  assert.deepEqual(publicProfile(profile), profile);
  assert.throws(() => publicProfile({ ...profile, discloseOnRequest: false }), /public business/);
  assert.throws(() => publicProfile({ ...profile, email: 'not-an-address' }), /public business/);
  assert.throws(
    () => publicProfile({ ...profile, email: 'support@example.test\r\nBcc: other@example.test' }),
    /public business/,
  );
  const complete = {
    ...profile,
    discloseOnRequest: false,
    name: '検証用事業者',
    address: '検証用住所',
    phone: '000-0000-0000',
  };
  assert.equal(publicProfile(complete).name, '検証用事業者');
  assert.throws(() => publicProfile({ ...complete, businessType: 'company' }), /public business/);
  assert.equal(
    publicProfile({ ...complete, businessType: 'company', representative: '検証用責任者' })
      .businessType,
    'company',
  );
});

const payment: CardPayment = {
  link_id: 'link',
  intent_id: 'pi_payment',
  checkout_id: 'cs_payment',
  amount: 12000,
  checkout_expires_at: 0,
  hold_until: 0,
  origin: 'https://favor.example.test',
};
test('Stripeの返金・異議申し立てを全ページ読み取り、金額と期限を取得する', async (t) => {
  const provider = new StripePayments('rk_test_fixture', 'whsec_fixture');
  const refunds = [
    {
      id: 're_pending',
      payment_intent: 'pi_payment',
      currency: 'jpy',
      amount: 1000,
      status: 'pending',
    },
    {
      id: 're_success',
      payment_intent: { id: 'pi_payment' },
      currency: 'jpy',
      amount: 2000,
      status: 'succeeded',
    },
    {
      id: 're_failed',
      payment_intent: 'pi_payment',
      currency: 'jpy',
      amount: 3000,
      status: 'failed',
      failure_reason: 'lost_or_stolen_card',
    },
  ];
  t.mock.method(
    provider.stripe.refunds,
    'list',
    async function* (params: { payment_intent: string }) {
      assert.equal(params.payment_intent, payment.intent_id);
      yield* structuredClone(refunds);
    },
  );
  const dispute = {
    id: 'dp_review',
    payment_intent: 'pi_payment',
    livemode: false,
    currency: 'jpy',
    amount: 12000,
    status: 'under_review',
    reason: 'fraudulent',
    evidence_details: { due_by: 1800000000 },
  };
  t.mock.method(provider.stripe.disputes, 'list', async function* () {
    yield structuredClone(dispute);
  });
  const items = await provider.adjustments(payment);
  assert.deepEqual(
    items.map((item) => [item.id, item.amount, item.status]),
    [
      ['re_pending', 1000, 'pending'],
      ['re_success', 2000, 'succeeded'],
      ['re_failed', 3000, 'failed'],
      ['dp_review', 12000, 'under_review'],
    ],
  );
  assert.equal(items[2]!.reason, 'lost_or_stolen_card');
  assert.equal(items[3]!.respondBy, 1800000000000);
  dispute.livemode = true;
  await assert.rejects(provider.adjustments(payment), { code: 'PAYMENT_MISMATCH' });
});

test('署名付きの返金・異議申し立て・送金通知を取引に結び付け、本番とテストを照合する', () => {
  for (const live of [false, true]) {
    const provider = new StripePayments(
      `rk_${live ? 'live' : 'test'}_fixture`,
      'whsec_fixture',
      {},
      live ? 'stripe_live' : 'stripe_test',
    );
    const event = (type: string, object: unknown, mode = live) => {
      const payload = JSON.stringify({
        id: 'evt_fixture',
        object: 'event',
        type,
        livemode: mode,
        data: { object },
      });
      const signature = provider.stripe.webhooks.generateTestHeaderString({
        payload,
        secret: 'whsec_fixture',
      });
      return provider.event(Buffer.from(payload), signature);
    };
    for (const type of ['refund.created', 'refund.updated', 'refund.failed'])
      assert.deepEqual(
        event(type, { object: 'refund', payment_intent: 'pi_payment', charge: 'ch_payment' }),
        { id: 'evt_fixture', intentId: 'pi_payment', chargeId: 'ch_payment' },
      );
    assert.equal(
      event('charge.dispute.closed', {
        object: 'dispute',
        payment_intent: 'pi_payment',
        charge: { id: 'ch_payment' },
      })?.chargeId,
      'ch_payment',
    );
    assert.equal(
      event('charge.refunded', { object: 'charge', payment_intent: 'pi_payment', id: 'ch_payment' })
        ?.intentId,
      'pi_payment',
    );
    assert.equal(
      event('transfer.reversed', { object: 'transfer', metadata: { favor_request_id: 'request' } })
        ?.requestId,
      'request',
    );
    assert.throws(() => event('refund.updated', { object: 'refund' }, !live), {
      code: 'INVALID_EVENT',
    });
  }
});

test('本番のカード仮押さえ期限と確定したChargeを照合する', async (t) => {
  const provider = new StripePayments('rk_live_fixture', 'whsec_fixture', {}, 'stripe_live');
  const intent = {
    id: payment.intent_id,
    livemode: true,
    metadata: { favor_link_id: payment.link_id },
    amount: payment.amount,
    currency: 'jpy',
    capture_method: 'manual',
    status: 'requires_capture',
    amount_capturable: payment.amount,
    amount_received: 0,
    latest_charge: {
      id: 'ch_paid',
      payment_method_details: { card: { capture_before: 1800000000 } },
    },
  };
  const session = {
    id: payment.checkout_id,
    livemode: true,
    metadata: { favor_link_id: payment.link_id },
    amount_total: payment.amount,
    currency: 'jpy',
    mode: 'payment',
    payment_intent: intent,
  };
  t.mock.method(provider.stripe.checkout.sessions, 'retrieve', async () =>
    structuredClone(session),
  );
  assert.equal((await provider.inspect(payment)).holdUntil, 1800000000000);
  intent.status = 'succeeded';
  intent.amount_received = payment.amount;
  assert.equal((await provider.inspect(payment)).chargeId, 'ch_paid');
  intent.amount_received = 11000;
  await assert.rejects(provider.inspect(payment), { code: 'PAYMENT_MISMATCH' });
  intent.amount_received = payment.amount;
  session.livemode = false;
  await assert.rejects(provider.inspect(payment), { code: 'PAYMENT_MISMATCH' });
});
