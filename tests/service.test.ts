import { MockPayments } from '../src/server/payment-provider.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RequestLinkInput } from '../src/shared.js';
import { RequestService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { AuthService } from '../src/server/auth.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { Mailbox } from './mailbox.js';
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function setup(options: ConstructorParameters<typeof MockPayments>[1] = {}) {
  let now = 1000000;
  const store = new Store();
  stores.push(store);
  const service = new RequestService(
    store,
    () => now,
    { acceptanceMs: 1000, authorizationMs: 1000, deliveryMs: 10000 },
    new MockPayments(() => now, { holdMs: 1000, ...options }),
  );
  const auth = new AuthService(store, () => now, { allowDemo: true });
  auth.demoLogin('client');
  const recipient = auth.identity(auth.demoLogin('creator')).account;
  const stranger = auth.actor(auth.demoLogin('other'));
  const links = new RequestLinkService(service, auth);
  const input: RequestLinkInput = {
    brief: '海辺の喫茶店を舞台にした短い物語をお願いします。',
    amount: 12000,
    visibility: 'public',
    agreeToRules: true,
  };
  const create = async (extra: Partial<RequestLinkInput> = {}) => {
    const link = await links.create('demo-client', randomUUID(), { ...input, ...extra });
    const accepted = await links.accept(recipient, link.token!, randomUUID(), true);
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
    auth,
    links,
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
  assert.rejects(
    async () => run(),
    (error) => error instanceof DomainError && error.code === code,
  );
test('受諾した依頼を納品し、依頼者がダウンロードする', async () => {
  const { service, create, effects } = setup();
  const request = await create();
  assert.equal(request.state, 'accepted');
  assert.equal(request.paymentState, 'authorized');
  const delivered = await service.deliver('demo-creator', request.id, randomUUID(), file);
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
test('支払確保の失敗時は作成を中断する', async () => {
  const { create, service, store } = setup({ failAuthorization: true });
  await throwsCode(async () => await create(), 'PAYMENT_DECLINED');
  assert.equal(service.list('demo-client').length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n, 0);
});
test('納品期限に達した依頼を一度だけ仮押さえを解除する', async () => {
  const { create, service, setTime, effects } = setup();
  const { id, deliverBy } = await create();
  setTime(deliverBy);
  service.expire();
  service.expire();
  await service.payments.reconcile();
  assert.equal(service.get('demo-client', id).paymentState, 'released');
  assert.equal(effects(id, 'release'), 1);
});

test('再納品では売上と期限を維持してファイルの版を更新する', async () => {
  const { create, service, effects } = setup();
  const { id, deliverBy } = await create();
  const key = randomUUID();
  const first = await service.deliver('demo-creator', id, key, file);
  assert.equal((await service.deliver('demo-creator', id, key, file)).deliveryVersion, 1);
  const second = await service.deliver('demo-creator', id, randomUUID(), file);
  assert.equal(second.deliveryVersion, 2);
  assert.equal(second.deliverBy, deliverBy);
  assert.notEqual(first.files[0]!.id, second.files[0]!.id);
  assert.equal(effects(id, 'sale'), 1);
});
test('納品期限とファイル選択を確認して納品を許可する', async () => {
  const { create, service, setTime } = setup();
  const { id, deliverBy } = await create();
  await throwsCode(
    async () => await service.deliver('demo-creator', id, randomUUID(), []),
    'INVALID_FILES',
  );
  await service.deliver('demo-creator', id, randomUUID(), file);
  setTime(deliverBy);
  await throwsCode(
    async () => await service.deliver('demo-creator', id, randomUUID(), file),
    'INVALID_STATE',
  );
  assert.equal(service.get('demo-client', id).state, 'delivered');
});
test('当事者と役割を確認して依頼の閲覧・納品・取得を許可する', async () => {
  const { create, service, stranger } = setup();
  const { id } = await create({ visibility: 'hidden' });
  for (const run of [
    () => service.get(stranger, id),
    async () => await service.cancel(stranger, id, randomUUID()),
    async () => await service.deliver(stranger, id, randomUUID(), file),
  ])
    await throwsCode(run, 'NOT_FOUND');
  await throwsCode(
    async () => await service.deliver('demo-client', id, randomUUID(), file),
    'FORBIDDEN',
  );
  const delivery = await service.deliver('demo-creator', id, randomUUID(), file);
  await throwsCode(() => service.download(stranger, id, delivery.files[0]!.id), 'NOT_FOUND');
  assert.equal(service.publicWorks().length, 0);
});
test('メールで届けた匿名依頼は、作り手にも公開情報にも依頼者名を出さない', async () => {
  const { service, auth, links, input } = setup();
  const mailbox = new Mailbox();
  const maker = auth.identity(await mailbox.login(auth, 'maker@example.test'));
  const link = await links.create('demo-client', randomUUID(), {
    ...input,
    visibility: 'anonymous',
    delivery: 'email',
    recipientEmail: 'maker@example.test',
  });
  const id = (await links.accept(maker.account, link.token!, randomUUID(), true, maker.email))
    .requestId!;
  const makerId = auth.actor(await mailbox.login(auth, 'maker@example.test'));
  assert.equal(service.get(makerId, id).clientName, '匿名の依頼者');
  assert.equal(JSON.stringify(service.list(makerId)).includes('demo-client'), false);
  await service.deliver(makerId, id, randomUUID(), file);
  const view = service.publicWorks()[0]!;
  assert.equal(view.clientName, '匿名の依頼者');
  assert.equal('amount' in view, false);
  assert.equal(view.brief, service.get('demo-client', id).brief);
  assert.equal(service.get('demo-client', id).clientName, '青葉 / aoba');
  assert.equal(view.files.length, 1);
});
test('依頼内容とファイル名・内容・個数を検証して保存する', async () => {
  const { create, service } = setup();
  await throwsCode(async () => await create({ amount: 1.5 }), 'INVALID_INPUT');
  await throwsCode(async () => await create({ brief: ' ' }), 'INVALID_INPUT');
  await throwsCode(async () => await create({ agreeToRules: false }), 'INVALID_INPUT');
  const { id } = await create();
  for (const name of ['../secret', 'a\nb.txt', 'folder\\secret'])
    await throwsCode(
      async () => await service.deliver('demo-creator', id, randomUUID(), [{ ...file[0]!, name }]),
      'INVALID_FILE_NAME',
    );
  await throwsCode(
    async () =>
      await service.deliver('demo-creator', id, randomUUID(), [{ name: 'empty.txt', content: '' }]),
    'FILE_TOO_LARGE',
  );
  await throwsCode(
    async () => await service.deliver('demo-creator', id, randomUUID(), Array(25).fill(file[0])),
    'INVALID_FILES',
  );
});
test('ファイルの合計サイズと形式を検証し、上限以内の納品を保存する', async () => {
  const { create, service, effects, store } = setup();
  const { id } = await create();
  const maximum = service.policy.maximumUploadBytes;
  const oversized = [{ name: 'large.bin', content: Buffer.alloc(maximum + 3).toString('base64') }];
  await throwsCode(
    async () => await service.deliver('demo-creator', id, randomUUID(), oversized),
    'INVALID_FILE',
  );
  const split = [maximum / 2, maximum / 2 + 1].map((length, index) => ({
    name: `${index}.bin`,
    content: Buffer.alloc(length).toString('base64'),
  }));
  await throwsCode(
    async () => await service.deliver('demo-creator', id, randomUUID(), split),
    'FILE_TOO_LARGE',
  );
  await throwsCode(
    async () =>
      await service.deliver('demo-creator', id, randomUUID(), [
        { name: 'bad.txt', content: 'abc' },
      ]),
    'INVALID_FILE',
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, 0);
  assert.equal(service.get('demo-client', id).state, 'accepted');
  assert.equal(effects(id, 'sale'), 0);
  const boundary = await service.deliver('demo-creator', id, randomUUID(), [
    { name: 'exact.bin', content: Buffer.alloc(maximum).toString('base64') },
  ]);
  assert.equal(boundary.files[0]!.size, maximum);
  assert.equal(effects(id, 'sale'), 1);
});
test('制作のギブアップを再試行しても一度だけ仮押さえを解除する', async () => {
  const { service, create, effects } = setup();
  const { id } = await create();
  const key = randomUUID();
  await throwsCode(
    async () => await service.cancel('demo-client', id, randomUUID()),
    'INVALID_STATE',
  );
  assert.equal((await service.cancel('demo-creator', id, key)).paymentState, 'released');
  assert.equal((await service.cancel('demo-creator', id, key)).state, 'cancelled');
  assert.equal((await service.cancel('demo-creator', id, randomUUID())).state, 'cancelled');
  assert.equal(effects(id, 'release'), 1);
});
