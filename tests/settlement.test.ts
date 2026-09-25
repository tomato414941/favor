import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/server/auth.js';
import {
  MockConnect,
  TransferRejected,
  type Reversal,
  type Transfer,
  type TransferScope,
} from '../src/server/connect-provider.js';
import {
  MockPayments,
  type Adjustment,
  type PaymentEvent,
} from '../src/server/payment-provider.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

class Cards extends MockPayments {
  items: Adjustment[] = [];
  unavailable = false;
  async adjustments() {
    if (this.unavailable) throw new Error('Provider unavailable');
    return structuredClone(this.items);
  }
  event(body: Buffer): PaymentEvent {
    return JSON.parse(body.toString()) as PaymentEvent;
  }
}
class Connect extends MockConnect {
  blockTransfer = false;
  blockReversal = false;
  loseTransfer = false;
  loseReversal = false;
  transferCalls = 0;
  reversalCalls = 0;
  async transfer(input: Transfer) {
    this.transferCalls++;
    if (this.blockTransfer) throw new Error('transfer unavailable');
    const id = await super.transfer(input);
    if (this.loseTransfer) {
      this.loseTransfer = false;
      throw new Error('transfer response lost');
    }
    return id;
  }
  async reverse(input: Reversal) {
    this.reversalCalls++;
    if (this.blockReversal) throw new TransferRejected();
    const id = await super.reverse(input);
    if (this.loseReversal) {
      this.loseReversal = false;
      throw new Error('reversal response lost');
    }
    return id;
  }
}
const adjustment = (
  kind: Adjustment['kind'],
  status: string,
  amount: number,
  id: string = kind,
): Adjustment => ({ id, kind, status, amount, reason: null, respondBy: null });

async function setup(t: TestContext, amount = 12001) {
  const directory = mkdtempSync(join(tmpdir(), 'favor-settlement-'));
  const path = join(directory, 'app.sqlite');
  let store = new Store(path);
  let now = Date.now();
  const clock = () => now;
  const cards = new Cards(clock);
  const connect = new Connect();
  let service = new RequestService(store, clock, {}, cards, connect);
  const auth = new AuthService(store, clock, { allowDemo: true });
  const sender = auth.actor(auth.demoLogin('client'));
  const recipient = auth.identity(auth.demoLogin('creator')).account;
  const links = new RequestLinkService(service, auth);
  await service.recipients.onboard(recipient.subject, 'http://localhost');
  const link = await links.create(sender, randomUUID(), {
    amount,
    brief: '海辺の絵',
    visibility: 'hidden',
    agreeToRules: true,
  });
  const { requestId } = await links.accept(recipient, link.token!, randomUUID(), true);
  const id = requestId!;
  const account = store.db
    .prepare('SELECT account_id FROM recipients WHERE user_id = ?')
    .get(recipient.subject)!.account_id as string;
  const scope: TransferScope = { request_id: id, link_id: link.link.id, account_id: account };
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  return {
    cards,
    connect,
    id,
    scope,
    sender,
    recipient,
    link,
    links,
    get service() {
      return service;
    },
    get store() {
      return store;
    },
    read: () => service.get(recipient.subject, id),
    net: async () =>
      (await connect.transfers(scope)).reduce(
        (sum, item) => sum + item.amount - item.reversedAmount,
        0,
      ),
    deliver: () =>
      service.deliver(recipient.subject, id, randomUUID(), [
        { name: 'art.txt', content: Buffer.from('作品').toString('base64') },
      ]),
    settle: () => service.transfers.settle(id),
    advance: () => {
      now += 2 * 86400000;
    },
    restart: () => {
      store.close();
      store = new Store(path);
      service = new RequestService(store, clock, {}, cards, connect);
    },
  };
}

test('複数回の一部返金を累計で按分し、全額返金で受取額をゼロにする', async (t) => {
  const s = await setup(t);
  await s.deliver();
  assert.equal(await s.net(), 11041);
  s.cards.items = [adjustment('refund', 'succeeded', 1, 're_one')];
  await s.settle();
  assert.equal(await s.net(), 11040);
  s.cards.items.push(adjustment('refund', 'succeeded', 6000, 're_two'));
  await s.settle();
  assert.equal(await s.net(), 5520);
  s.cards.items.push(adjustment('refund', 'succeeded', 6000, 're_three'));
  await s.settle();
  assert.equal(await s.net(), 0);
  assert.equal(s.read().transferState, 'recovered');
  assert.equal(s.read().settlement.refunded, 12001);
  assert.equal(s.links.read(s.link.token!, s.recipient).settlement.refunded, 12001);
  assert.equal(
    Buffer.from(s.service.download(s.sender, s.id, s.read().files[0]!.id).data).toString(),
    '作品',
  );
  await Promise.all([s.settle(), s.settle()]);
  assert.equal(s.connect.reversalCalls, 3);
});

test('送金前の返金完了を反映して残額だけを受取先へ送金する', async (t) => {
  const s = await setup(t, 12000);
  s.cards.items = [adjustment('refund', 'succeeded', 3000)];
  await s.deliver();
  assert.equal(await s.net(), 8280);
  assert.equal(s.read().transferState, 'transferred');
  assert.equal(s.connect.reversalCalls, 0);
});

test('返金手続き中は新しい送金を保留し、返金失敗後は受取額を送金する', async (t) => {
  const s = await setup(t);
  s.cards.items = [adjustment('refund', 'pending', 12001)];
  await s.deliver();
  assert.equal(await s.net(), 0);
  assert.equal(s.read().transferState, 'held');
  assert.equal(s.read().settlement.refundPending, 12001);
  s.cards.items[0]!.status = 'failed';
  await s.settle();
  assert.equal(await s.net(), 11041);
  assert.equal(s.read().transferState, 'transferred');
  assert.equal(s.read().settlement.refundFailed, 12001);
});

test('送金済みの返金を回収し、後から返金失敗が確定した場合は売上を戻す', async (t) => {
  const s = await setup(t, 12000);
  await s.deliver();
  s.cards.items = [adjustment('refund', 'succeeded', 6000)];
  await s.settle();
  assert.equal(await s.net(), 5520);
  s.cards.items[0]!.status = 'failed';
  await s.settle();
  assert.equal(await s.net(), 11040);
  assert.equal(s.connect.transferCalls, 2);
  assert.equal(s.read().settlement.refunded, 0);
});

test('異議申し立て中は送金を保留し、支払い確定で再開、支払い取消で回収する', async (t) => {
  const s = await setup(t);
  s.cards.items = [adjustment('dispute', 'needs_response', 12001)];
  await s.deliver();
  assert.equal(s.read().settlement.dispute, 'open');
  assert.equal(s.read().transferState, 'held');
  assert.equal(await s.net(), 0);
  s.cards.items[0]!.status = 'won';
  await s.settle();
  assert.equal(await s.net(), 11041);
  s.cards.items[0]!.status = 'lost';
  await s.settle();
  assert.equal(await s.net(), 0);
  assert.equal(s.read().settlement.dispute, 'lost');
});

test('受取先の残高不足による回収失敗を記録し、残高が戻れば再試行する', async (t) => {
  const s = await setup(t);
  await s.deliver();
  s.cards.items = [adjustment('refund', 'succeeded', 12001)];
  s.connect.blockReversal = true;
  await assert.rejects(s.settle(), TransferRejected);
  assert.equal(s.read().transferState, 'recovery_pending');
  assert.equal(
    s.store.db.prepare('SELECT error_code FROM transfers WHERE request_id = ?').get(s.id)!
      .error_code,
    'balance_insufficient',
  );
  assert.equal(await s.net(), 11041);
  s.restart();
  s.connect.blockReversal = false;
  s.advance();
  await s.service.transfers.reconcile();
  assert.equal(s.read().transferState, 'recovered');
  assert.equal(await s.net(), 0);
});

test('送金・回収の応答を失っても再起動後にStripeの結果を照合して一度だけ反映する', async (t) => {
  const s = await setup(t);
  s.connect.loseTransfer = true;
  await s.deliver();
  assert.equal(s.read().transferState, 'pending');
  assert.equal(await s.net(), 11041);
  s.restart();
  await Promise.all([s.settle(), s.settle()]);
  assert.equal(s.connect.transferCalls, 1);
  s.cards.items = [adjustment('refund', 'succeeded', 12001)];
  s.connect.loseReversal = true;
  await assert.rejects(s.settle(), /reversal response lost/);
  s.restart();
  await Promise.all([s.settle(), s.settle()]);
  assert.equal(s.connect.reversalCalls, 1);
  assert.equal(s.read().transferState, 'recovered');
});

test('通知の順番や重複によらずStripeの現在の返金状態を反映する', async (t) => {
  const s = await setup(t);
  await s.deliver();
  s.cards.items = [adjustment('refund', 'succeeded', 1000)];
  const notify = (id: string) =>
    s.service.payments.webhook(Buffer.from(JSON.stringify({ id, requestId: s.id })), 'fixture');
  await Promise.all([notify('event_new'), notify('event_old'), notify('event_new')]);
  await s.service.transfers.reconcile();
  assert.equal(s.read().settlement.refunded, 1000);
  assert.equal(s.connect.reversalCalls, 1);
  assert.equal(await s.net(), 10120);
});

test('手動で取り消した送金を保留として記録し、運営者の確認を待つ', async (t) => {
  const s = await setup(t);
  await s.deliver();
  const transfer = (await s.connect.transfers(s.scope))[0]!;
  await s.connect.reverse({
    ...s.scope,
    amount: 1000,
    operation_id: 'manual',
    transfer_id: transfer.id,
  });
  await s.settle();
  assert.equal(s.read().transferState, 'held');
  assert.equal(await s.net(), 10041);
  assert.equal(s.connect.transferCalls, 1);
});

test('応答未確認の送金と返金が競合したときは送金を保留して記録する', async (t) => {
  const s = await setup(t);
  s.connect.blockTransfer = true;
  await s.deliver();
  s.cards.items = [adjustment('refund', 'succeeded', 12001)];
  s.connect.blockTransfer = false;
  await s.settle();
  assert.equal(s.read().transferState, 'held');
  assert.equal(await s.net(), 0);
  assert.equal(
    s.store.db.prepare('SELECT error_code FROM transfers WHERE request_id = ?').get(s.id)!
      .error_code,
    'UNCONFIRMED_OPERATION',
  );
});

test('支払先の照会に失敗したときは確認できるまで新しい送金を待つ', async (t) => {
  const s = await setup(t);
  s.cards.unavailable = true;
  await s.deliver();
  assert.equal(s.read().transferState, 'pending');
  assert.equal(await s.net(), 0);
  s.cards.unavailable = false;
  await s.settle();
  assert.equal(await s.net(), 11041);
});
