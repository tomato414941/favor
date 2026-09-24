import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RequestLinkInput } from '../src/shared.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { RequestLinkService } from '../src/server/request-links.js';

const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function setup(options: ConstructorParameters<typeof CommissionService>[3] = {}) {
  let now = 1_000_000;
  const store = new Store();
  stores.push(store);
  const service = new CommissionService(
    store,
    () => now,
    { acceptanceMs: 1000, authorizationMs: 1000, deliveryMs: 10000 },
    options,
  );
  const auth = new AuthService(store, () => now, { allowDemo: true });
  auth.demoLogin('client');
  const recipient = auth.identity(auth.demoLogin('creator')).account;
  const stranger = auth.registerAccount(auth.demoLogin('other'));
  const links = new RequestLinkService(service, auth);
  const input: RequestLinkInput = {
    brief: '海辺の喫茶店を舞台にした短い物語をお願いします。',
    amount: 12000,
    visibility: 'public',
    agreeToRules: true,
  };
  const create = (extra: Partial<RequestLinkInput> = {}) => {
    const link = links.create('demo-client', randomUUID(), { ...input, ...extra });
    const accepted = links.accept(recipient, link.token!, randomUUID(), true);
    return service.get('demo-creator', accepted.requestId!);
  };
  const effects = (id: string, operation: string) =>
    Number(
      store.db
        .prepare('SELECT COUNT(*) AS n FROM effects WHERE request_id = ? AND operation = ?')
        .get(id, operation)!.n,
    );
  return {
    store,
    service,
    input,
    create,
    effects,
    stranger,
    setTime: (value: number) => {
      now = value;
    },
  };
}
const file = [
  { name: 'story.txt', content: Buffer.from('波音の聞こえる喫茶店で。').toString('base64') },
];
const throwsCode = (run: () => unknown, code: string) =>
  assert.throws(run, (error) => error instanceof DomainError && error.code === code);

test('受諾した依頼を納品し、依頼者がダウンロードする', () => {
  const { service, create, effects } = setup();
  const request = create();
  assert.equal(request.state, 'accepted');
  assert.equal(request.paymentState, 'captured');
  const delivered = service.deliver('demo-creator', request.id, randomUUID(), file);
  assert.equal(delivered.state, 'delivered');
  assert.equal(
    Buffer.from(
      service.download('demo-client', request.id, delivered.files[0]!.id).data,
    ).toString(),
    '波音の聞こえる喫茶店で。',
  );
  assert.equal(effects(request.id, 'capture'), 1);
  assert.equal(effects(request.id, 'sale'), 1);
});
test('支払確保の失敗時は作成を中断する', () => {
  const { create, service, store } = setup({ failAuthorization: true });
  throwsCode(() => create(), 'PAYMENT_DECLINED');
  assert.equal(service.list('demo-client').length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n, 0);
});
test('納品期限に達した依頼を一度だけ返金する', () => {
  const { create, service, setTime, effects } = setup();
  const { id, deliverBy } = create();
  setTime(deliverBy);
  service.expire();
  service.expire();
  assert.equal(service.get('demo-client', id).paymentState, 'refunded');
  assert.equal(effects(id, 'refund'), 1);
});
test('支払確認が完了した依頼の制作を開始する', () => {
  const { create, service } = setup({ deferCardCapture: true });
  const { id } = create();
  assert.equal(service.get('demo-creator', id).state, 'accepting');
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), file), 'INVALID_STATE');
  service.completeMockCapture(id, 'event-success');
  assert.equal(service.get('demo-client', id).state, 'accepted');
});
test('期限切れ後の決済通知を重複して受け取っても一度だけ返金する', () => {
  const { create, service, setTime, effects } = setup({ deferCardCapture: true });
  const { id, acceptBy } = create();
  setTime(acceptBy);
  service.expire();
  service.completeMockCapture(id, 'late-event');
  service.completeMockCapture(id, 'late-event');
  service.completeMockCapture(id, 'duplicate-event');
  assert.equal(service.get('demo-client', id).state, 'cancelled');
  assert.equal(service.get('demo-client', id).paymentState, 'refunded');
  assert.equal(effects(id, 'capture'), 1);
  assert.equal(effects(id, 'refund'), 1);
});
test('決済通知の識別子を一つの支払いにひも付けて処理する', () => {
  const { create, service } = setup({ deferCardCapture: true });
  const one = create();
  const two = create();
  service.completeMockCapture(one.id, 'shared-event');
  throwsCode(() => service.completeMockCapture(two.id, 'shared-event'), 'EVENT_REUSED');
});
test('再納品では売上と期限を維持してファイルの版を更新する', () => {
  const { create, service, effects } = setup();
  const { id, deliverBy } = create();
  const key = randomUUID();
  const first = service.deliver('demo-creator', id, key, file);
  assert.equal(service.deliver('demo-creator', id, key, file).deliveryVersion, 1);
  const second = service.deliver('demo-creator', id, randomUUID(), file);
  assert.equal(second.deliveryVersion, 2);
  assert.equal(second.deliverBy, deliverBy);
  assert.notEqual(first.files[0]!.id, second.files[0]!.id);
  assert.equal(effects(id, 'sale'), 1);
});
test('納品期限とファイル選択を確認して納品を許可する', () => {
  const { create, service, setTime } = setup();
  const { id, deliverBy } = create();
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), []), 'INVALID_FILES');
  service.deliver('demo-creator', id, randomUUID(), file);
  setTime(deliverBy);
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), file), 'INVALID_STATE');
  assert.equal(service.get('demo-client', id).state, 'delivered');
});
test('当事者と役割を確認して依頼の閲覧・納品・取得を許可する', () => {
  const { create, service, stranger } = setup();
  const { id } = create({ visibility: 'hidden' });
  for (const run of [
    () => service.get(stranger, id),
    () => service.cancel(stranger, id, randomUUID()),
    () => service.deliver(stranger, id, randomUUID(), file),
  ])
    throwsCode(run, 'NOT_FOUND');
  throwsCode(() => service.deliver('demo-client', id, randomUUID(), file), 'FORBIDDEN');

  const delivery = service.deliver('demo-creator', id, randomUUID(), file);
  throwsCode(() => service.download(stranger, id, delivery.files[0]!.id), 'NOT_FOUND');
  assert.equal(service.publicWorks().length, 0);
});
test('匿名依頼の公開情報と当事者の支払情報を区別して表示する', () => {
  const { create, service } = setup();
  const { id } = create({ visibility: 'anonymous' });
  assert.equal(service.get('demo-creator', id).clientName, '匿名の依頼者');
  assert.equal(JSON.stringify(service.list('demo-creator')).includes('demo-client'), false);
  service.deliver('demo-creator', id, randomUUID(), file);
  const view = service.publicWorks()[0]!;
  assert.equal(view.clientName, '匿名の依頼者');
  assert.equal('amount' in view, false);
  assert.equal(view.brief, service.get('demo-client', id).brief);
  assert.equal(service.get('demo-client', id).clientName, '青葉 / aoba');
  assert.equal(view.files.length, 1);
});
test('依頼内容とファイル名・内容・個数を検証して保存する', () => {
  const { create, service } = setup();
  throwsCode(() => create({ amount: 1.5 }), 'INVALID_INPUT');
  throwsCode(() => create({ brief: ' ' }), 'INVALID_INPUT');
  throwsCode(() => create({ agreeToRules: false }), 'INVALID_INPUT');
  const { id } = create();
  for (const name of ['../secret', 'a\nb.txt', 'folder\\secret'])
    throwsCode(
      () => service.deliver('demo-creator', id, randomUUID(), [{ ...file[0]!, name }]),
      'INVALID_FILE_NAME',
    );
  throwsCode(
    () => service.deliver('demo-creator', id, randomUUID(), [{ name: 'empty.txt', content: '' }]),
    'FILE_TOO_LARGE',
  );
  throwsCode(
    () => service.deliver('demo-creator', id, randomUUID(), Array(25).fill(file[0])),
    'INVALID_FILES',
  );
});
test('ファイルの合計サイズと形式を検証し、上限以内の納品を保存する', () => {
  const { create, service, effects, store } = setup();
  const { id } = create();
  const maximum = service.policy.maximumUploadBytes;
  const oversized = [{ name: 'large.bin', content: Buffer.alloc(maximum + 3).toString('base64') }];
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), oversized), 'INVALID_FILE');
  const split = [maximum / 2, maximum / 2 + 1].map((length, index) => ({
    name: `${index}.bin`,
    content: Buffer.alloc(length).toString('base64'),
  }));
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), split), 'FILE_TOO_LARGE');
  throwsCode(
    () => service.deliver('demo-creator', id, randomUUID(), [{ name: 'bad.txt', content: 'abc' }]),
    'INVALID_FILE',
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, 0);
  assert.equal(service.get('demo-client', id).state, 'accepted');
  assert.equal(effects(id, 'sale'), 0);
  const boundary = service.deliver('demo-creator', id, randomUUID(), [
    { name: 'exact.bin', content: Buffer.alloc(maximum).toString('base64') },
  ]);
  assert.equal(boundary.files[0]!.size, maximum);
  assert.equal(effects(id, 'sale'), 1);
});

test('制作のギブアップを再試行しても一度だけ返金する', () => {
  const { service, create, effects } = setup();
  const { id } = create();
  const key = randomUUID();
  throwsCode(() => service.cancel('demo-client', id, randomUUID()), 'INVALID_STATE');
  assert.equal(service.cancel('demo-creator', id, key).paymentState, 'refunded');
  assert.equal(service.cancel('demo-creator', id, key).state, 'cancelled');
  assert.equal(service.cancel('demo-creator', id, randomUUID()).state, 'cancelled');
  assert.equal(effects(id, 'refund'), 1);
});
