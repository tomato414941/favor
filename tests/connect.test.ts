import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { AuthService } from '../src/server/auth.js';
import {
  StripeConnect,
  MockConnect,
  TransferRejected,
  type Recipient,
  type Transfer,
} from '../src/server/connect-provider.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import type { RecipientState } from '../src/shared.js';
import { serve } from './http.js';

const input = {
  brief: '海辺の絵をお願いします。',
  amount: 12000,
  visibility: 'hidden' as const,
  agreeToRules: true,
};
const files = [{ name: 'art.txt', content: Buffer.from('完成した作品').toString('base64') }];
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;

class Connect extends MockConnect {
  readonly mode = 'mock' as const;
  readonly accounts = new Map<string, string>();
  readonly states = new Map<string, RecipientState>();
  readonly sent = new Map<string, Transfer>();
  readonly emails: string[] = [];
  readonly origins: string[] = [];
  readonly dashboards: string[] = [];
  loseCreation = false;
  loseTransfer = false;
  async create(recipient: Recipient, email: string) {
    if (!this.accounts.has(recipient.id)) {
      this.accounts.set(recipient.id, `acct_${randomUUID()}`);
      this.emails.push(email);
    }
    if (this.loseCreation) {
      this.loseCreation = false;
      throw new Error('creation response lost');
    }
    return this.accounts.get(recipient.id)!;
  }
  async inspect(recipient: Recipient): Promise<RecipientState> {
    return this.states.get(recipient.account_id!) ?? 'incomplete';
  }
  async onboarding(_recipient: Recipient, origin: string) {
    this.origins.push(origin);
    return 'https://connect.stripe.com/setup/fixture';
  }
  async dashboard(recipient: Recipient) {
    this.dashboards.push(recipient.account_id!);
    return `https://connect.stripe.com/express/${recipient.account_id}`;
  }
  async transfer(transfer: Transfer) {
    const id = await super.transfer(transfer);
    if (!this.sent.has(transfer.request_id)) this.sent.set(transfer.request_id, { ...transfer });
    if (this.loseTransfer) {
      this.loseTransfer = false;
      throw new Error('transfer response lost');
    }
    return id;
  }
}
function setup(path?: string, connect = new Connect()) {
  let now = Date.now();
  const store = new Store(path);
  const service = new RequestService(store, () => now, {}, undefined, connect);
  const auth = new AuthService(store, () => now, { allowDemo: true });
  const sender = auth.actor(auth.demoLogin('client'));
  const recipient = auth.identity(auth.demoLogin('creator')).account;
  const links = new RequestLinkService(service, auth);
  const create = () => links.create(sender, randomUUID(), input);
  const ready = async () => {
    await service.recipients.onboard(recipient.subject, 'http://localhost');
    const account = String(
      store.db
        .prepare('SELECT account_id FROM recipients WHERE user_id = ?')
        .get(recipient.subject)!.account_id,
    );
    connect.states.set(account, 'ready');
    return account;
  };
  return {
    store,
    service,
    sender,
    recipient,
    links,
    connect,
    create,
    ready,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('Stripeの受取可能状態を受諾時と初回納品時に確認する', async () => {
  const s = setup();
  try {
    const link = await s.create();
    const accept = () => s.links.accept(s.recipient, link.token!, randomUUID(), true);
    assert.equal((await s.service.recipients.status(s.recipient.subject)).state, 'unregistered');
    await assert.rejects(accept(), code('RECIPIENT_REQUIRED'));
    const account = await s.ready();
    for (const state of ['incomplete', 'reviewing'] as const) {
      s.connect.states.set(account, state);
      await assert.rejects(accept(), code('RECIPIENT_REQUIRED'));
      assert.equal(s.links.read(link.token!).state, 'pending');
    }
    s.connect.states.set(account, 'ready');
    const accepted = await accept();
    s.connect.states.set(account, 'incomplete');
    await assert.rejects(
      s.service.deliver(s.recipient.subject, accepted.requestId!, randomUUID(), files),
      code('RECIPIENT_REQUIRED'),
    );
    assert.equal(s.service.get(s.sender, accepted.requestId!).paymentState, 'authorized');
    s.connect.states.set(account, 'ready');
    const delivered = await s.service.deliver(
      s.recipient.subject,
      accepted.requestId!,
      randomUUID(),
      files,
    );
    assert.equal(delivered.transferState, 'transferred');
    const transfer = s.connect.sent.get(delivered.id)!;
    assert.equal(transfer.account_id, account);
    assert.equal(transfer.amount, 11040);
    assert.equal(transfer.payment_amount, input.amount);
    assert.equal(transfer.link_id, link.link.id);
  } finally {
    s.store.close();
  }
});

test('受取人作成の通信断から再起動しても同じアカウントで登録を再開する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-connect-'));
  const path = join(directory, 'app.sqlite');
  let s = setup(path);
  try {
    s.connect.loseCreation = true;
    await assert.rejects(
      s.service.recipients.onboard(s.recipient.subject, 'http://localhost'),
      /creation response lost/,
    );
    const connect = s.connect;
    s.store.close();
    s = setup(path, connect);
    await Promise.all([s.ready(), s.ready()]);
    assert.equal(connect.accounts.size, 1);
    assert.deepEqual(connect.emails, ['nagi@favor.test']);
    assert.equal((await s.service.recipients.status(s.recipient.subject)).state, 'ready');
  } finally {
    s.store.close();
    rmSync(directory, { recursive: true });
  }
});

test('送金の通信断でも納品を保存し、再起動後に同じ相手への送金を確認する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-transfer-'));
  const path = join(directory, 'app.sqlite');
  let s = setup(path);
  try {
    await s.ready();
    const link = await s.create();
    const { requestId: id } = await s.links.accept(s.recipient, link.token!, randomUUID(), true);
    s.connect.loseTransfer = true;
    const delivered = await s.service.deliver(s.recipient.subject, id!, randomUUID(), files);
    assert.equal(delivered.paymentState, 'captured');
    assert.equal(delivered.transferState, 'pending');
    assert.equal(
      Buffer.from(s.service.download(s.sender, id!, delivered.files[0]!.id).data).toString(),
      '完成した作品',
    );
    const connect = s.connect;
    s.store.close();
    s = setup(path, connect);
    s.advance(2 * 86400000);
    await Promise.all([s.service.transfers.reconcile(), s.service.transfers.settle(id!)]);
    assert.equal(s.service.get(s.recipient.subject, id!).transferState, 'transferred');
    await s.service.deliver(s.recipient.subject, id!, randomUUID(), files);
    assert.equal(connect.sent.size, 1);
    assert.equal(connect.sent.get(id!)!.amount, 11040);
    assert.equal(s.service.get(s.recipient.subject, id!).recipientAmount, 11040);
    assert.equal(
      s.store.db
        .prepare("SELECT COUNT(*) AS n FROM effects WHERE request_id = ? AND operation = 'capture'")
        .get(id!)!.n,
      1,
    );
    assert.equal(
      s.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM effects WHERE request_id = ? AND operation = 'transfer'",
        )
        .get(id!)!.n,
      1,
    );
  } finally {
    s.store.close();
    rmSync(directory, { recursive: true });
  }
});

test('ログイン中の本人のメールと受取先だけを使い、登録画面へ固定の戻り先を渡す', async () => {
  const s = setup();
  const app = await serve(s.service);
  try {
    const anonymous = await app.request('/me/settings');
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/login?next=%2Fme%2Fsettings');
    const cookie = await app.login('recipient@example.test');
    const onboard = { intent: 'onboard' };
    assert.equal(
      (
        await app.request('/me/settings', {
          cookie,
          form: onboard,
          headers: { origin: 'https://attacker.example' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.request('/me/settings', {
          cookie,
          form: onboard,
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
      403,
    );
    const response = await app.request('/me/settings', {
      cookie,
      form: {
        ...onboard,
        account: 'acct_other',
        email: 'other@example.test',
        return_url: 'https://attacker.example/link#private',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(s.connect.emails, ['recipient@example.test']);
    assert.deepEqual(s.connect.origins, ['http://localhost']);
    const state = await app.request('/me/settings?onboarding=return&state=ready', { cookie });
    assert.equal(state.status, 200);
    assert.match(await state.text(), /登録内容を確認してください。/);
    assert.equal(
      s.store.db
        .prepare('SELECT state FROM recipients WHERE account_id = ?')
        .get([...s.connect.accounts.values()][0]!)!.state,
      'incomplete',
    );
    const dashboard = await app.request('/me/settings', {
      cookie,
      form: { intent: 'dashboard', account: 'acct_other' },
    });
    assert.equal(dashboard.status, 200);
    assert.deepEqual(s.connect.dashboards, [[...s.connect.accounts.values()][0]]);
  } finally {
    await app.close();
    s.store.close();
  }
});

function stripeFixture(live = false) {
  const recipient = { id: 'registration', account_id: 'acct_recipient' };
  const account = {
    id: recipient.account_id,
    livemode: live,
    dashboard: 'express',
    identity: { country: 'JP' },
    defaults: {
      responsibilities: {
        requirements_collector: 'stripe',
        fees_collector: 'application',
        losses_collector: 'application',
      },
    },
    metadata: { favor_recipient_id: recipient.id },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: { stripe_transfers: { status: 'active' }, payouts: { status: 'active' } },
        },
      },
    },
    requirements: {
      entries: [] as { minimum_deadline: { status: string }; awaiting_action_from: string }[],
    },
  };
  let sourceTransaction: string | undefined;
  const sent: Stripe.Transfer[] = [];
  const reversals: Stripe.TransferReversal[] = [];
  const intent = {
    livemode: live,
    status: 'succeeded',
    currency: 'jpy',
    amount_received: 12000,
    metadata: { favor_link_id: 'link' },
    latest_charge: { id: 'ch_captured', captured: true, amount_refunded: 0 },
  };
  const payouts = {
    schedule: { interval: 'weekly', weekly_payout_days: ['friday'] },
    minimum_balance_by_currency: { jpy: 0 },
    status: 'enabled',
  };
  const stripe = {
    balanceSettings: {
      retrieve: async (_: unknown, options: { stripeAccount: string }) => {
        assert.equal(options.stripeAccount, recipient.account_id);
        return { payments: { payouts: structuredClone(payouts) } };
      },
    },
    v2: {
      core: {
        accounts: {
          retrieve: async () => structuredClone(account),
          list: async function* () {
            yield account;
          },
          create: async () => {
            throw Error('unexpected account');
          },
        },
      },
    },
    paymentIntents: {
      retrieve: async () => structuredClone(intent),
    },
    transfers: {
      list: async function* () {
        yield* structuredClone(sent);
      },
      create: async (params: Stripe.TransferCreateParams) => {
        sourceTransaction = params.source_transaction;
        const result = {
          id: sent.length ? `tr_restored_${sent.length}` : 'tr_confirmed',
          livemode: live,
          ...params,
          reversed: false,
          amount_reversed: 0,
        } as Stripe.Transfer;
        sent.push(result);
        return result;
      },
      listReversals: async function* (id: string) {
        yield* structuredClone(reversals.filter((item) => item.transfer === id));
      },
      createReversal: async (id: string, params: Stripe.TransferCreateReversalParams) => {
        const transfer = sent.find((item) => item.id === id)!;
        const amount = params.amount!;
        assert.ok(transfer.amount_reversed + amount <= transfer.amount);
        transfer.amount_reversed += amount;
        const reversal = {
          id: `trr_${reversals.length}`,
          transfer: id,
          amount,
          metadata: params.metadata,
        } as Stripe.TransferReversal;
        reversals.push(reversal);
        return structuredClone(reversal);
      },
    },
  } as unknown as Stripe;
  return {
    recipient,
    account,
    intent,
    payouts,
    sent,
    reversals,
    stripe,
    provider: new StripeConnect(stripe, live ? 'stripe_live' : 'stripe_test'),
    sourceTransaction: () => sourceTransaction,
  };
}

test('受取機能と確認期限を照合してStripeの登録状態を判定する', async () => {
  const s = stripeFixture();
  assert.equal(await s.provider.inspect(s.recipient), 'ready');
  s.payouts.status = 'disabled';
  assert.equal(await s.provider.inspect(s.recipient), 'incomplete');
  s.payouts.status = 'enabled';
  s.account.configuration.recipient.capabilities.stripe_balance.payouts.status = 'restricted';
  assert.equal(await s.provider.inspect(s.recipient), 'incomplete');
  s.account.requirements.entries = [
    { minimum_deadline: { status: 'currently_due' }, awaiting_action_from: 'stripe' },
  ];
  assert.equal(await s.provider.inspect(s.recipient), 'reviewing');
  s.account.configuration.recipient.capabilities.stripe_balance.payouts.status = 'active';
  s.account.requirements.entries[0]!.awaiting_action_from = 'user';
  assert.equal(await s.provider.inspect(s.recipient), 'incomplete');
  s.account.livemode = true;
  await assert.rejects(s.provider.inspect(s.recipient), code('CONNECT_MISMATCH'));
  s.account.livemode = false;
  s.account.metadata.favor_recipient_id = 'somebody-else';
  await assert.rejects(s.provider.inspect(s.recipient), code('CONNECT_MISMATCH'));
});

test('毎週金曜日の自動振込と留保額ゼロを照合して受取可能と判定する', async () => {
  const s = stripeFixture();
  s.payouts.schedule.interval = 'manual';
  await assert.rejects(s.provider.inspect(s.recipient), code('PAYOUT_SETTINGS'));
  s.payouts.schedule.interval = 'weekly';
  s.payouts.schedule.weekly_payout_days = ['monday'];
  await assert.rejects(s.provider.inspect(s.recipient), code('PAYOUT_SETTINGS'));
  s.payouts.schedule.weekly_payout_days = ['friday'];
  s.payouts.minimum_balance_by_currency.jpy = 5000;
  await assert.rejects(s.provider.inspect(s.recipient), code('PAYOUT_SETTINGS'));
  s.payouts.minimum_balance_by_currency.jpy = 0;
  assert.equal(await s.provider.inspect(s.recipient), 'ready');
});

test('納品の決済を送金元に指定し、再試行ではStripe上の送金先と金額を照合する', async () => {
  const s = stripeFixture();
  const transfer = {
    operation_id: 'operation',
    request_id: 'request',
    link_id: 'link',
    account_id: s.recipient.account_id,
    recipient_id: s.recipient.id,
    amount: 11040,
    payment_amount: 12000,
    intent_id: 'pi_paid',
  };
  assert.equal(await s.provider.transfer(transfer), 'tr_confirmed');
  assert.equal(s.sourceTransaction(), 'ch_captured');
  assert.equal(s.sent[0]!.amount, 11040);
  assert.equal(await s.provider.transfer(transfer), 'tr_confirmed');
  assert.equal(s.sent.length, 1);
  for (const invalid of [
    { amount: 13000 },
    { account_id: 'acct_other' },
    { request_id: 'other-request' },
  ])
    await assert.rejects(
      s.provider.transfer({ ...transfer, ...invalid }),
      code('CONNECT_MISMATCH'),
    );
});

test('依頼の全額が決済済みであることを照合して利用料を引いた額を送金する', async () => {
  const s = stripeFixture();
  const transfer = {
    operation_id: 'operation',
    request_id: 'request',
    link_id: 'link',
    account_id: s.recipient.account_id,
    recipient_id: s.recipient.id,
    amount: 11040,
    payment_amount: 12000,
    intent_id: 'pi_paid',
  };
  s.intent.amount_received = 11040;
  await assert.rejects(s.provider.transfer(transfer), code('CONNECT_MISMATCH'));
  s.intent.amount_received = 12000;
  assert.equal(await s.provider.transfer(transfer), 'tr_confirmed');
  assert.equal(s.sent[0]!.amount, 11040);
});

test('作成済みの受取人をStripeから検索して同じ登録を復元する', async () => {
  const s = stripeFixture();
  assert.equal(
    await s.provider.create({ id: s.recipient.id, account_id: null }, 'maker@example.test'),
    s.recipient.account_id,
  );
});

test('Stripeの送金取消を照合して再試行し、売上を戻すときは新しい送金を作成する', async () => {
  for (const live of [false, true]) {
    const s = stripeFixture(live);
    const transfer: Transfer = {
      operation_id: 'initial',
      request_id: 'request',
      link_id: 'link',
      account_id: s.recipient.account_id,
      recipient_id: s.recipient.id,
      amount: 11040,
      payment_amount: 12000,
      intent_id: 'pi_paid',
    };
    const id = await s.provider.transfer(transfer);
    const reversal = { ...transfer, operation_id: 'refund', transfer_id: id, amount: 5520 };
    const reversed = await s.provider.reverse(reversal);
    assert.equal(await s.provider.reverse(reversal), reversed);
    assert.equal(s.reversals.length, 1);
    assert.equal((await s.provider.transfers(transfer))[0]!.reversedAmount, 5520);
    assert.equal(
      await s.provider.findOperation(transfer, {
        id: 'refund',
        kind: 'reversal',
        amount: 5520,
        source_id: id,
      }),
      reversed,
    );
    await assert.rejects(
      s.provider.reverse({ ...reversal, amount: 11040 }),
      code('CONNECT_MISMATCH'),
    );
    const restored = await s.provider.transfer({
      ...transfer,
      amount: 5520,
      operation_id: 'restore',
    });
    assert.notEqual(restored, id);
    assert.equal(s.sourceTransaction(), undefined);
    assert.equal(
      await s.provider.findOperation(transfer, {
        id: 'restore',
        kind: 'transfer',
        amount: 5520,
        source_id: null,
      }),
      restored,
    );
    assert.equal(
      s.sent.reduce((sum, item) => sum + item.amount - item.amount_reversed, 0),
      11040,
    );
  }
});

test('Stripeが残高不足で拒否した送金を、応答不明の送金と区別する', async (t) => {
  const s = stripeFixture();
  const transfer: Transfer = {
    operation_id: 'initial',
    request_id: 'request',
    link_id: 'link',
    account_id: s.recipient.account_id,
    recipient_id: s.recipient.id,
    amount: 11040,
    payment_amount: 12000,
    intent_id: 'pi_paid',
  };
  t.mock.method(s.stripe.transfers, 'create', async () => {
    throw new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'balance_insufficient',
    });
  });
  await assert.rejects(s.provider.transfer(transfer), TransferRejected);
});
