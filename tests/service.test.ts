import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestInput } from '../src/shared.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
function setup(options: ConstructorParameters<typeof CommissionService>[3] = {}) {
  let now = 1_000_000;
  const store = new Store(); stores.push(store);
  const service = new CommissionService(store, () => now, { acceptanceMs: 1000, authorizationMs: 1000, deliveryMs: 10000 }, options);
  const input: RequestInput = { creatorId: 'demo-creator', brief: '海辺の喫茶店を舞台にした短い物語をお願いします。', amount: 12000, visibility: 'public', paymentMethod: 'card', nsfw: false, agreeToRules: true };
  const create = (extra: Partial<RequestInput> = {}, actor = 'demo-client', key = randomUUID()) => service.create(actor, key, { ...input, ...extra });
  const effects = (id: string, operation: string) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM effects WHERE request_id = ? AND operation = ?').get(id, operation)!.n);
  return { store, service, input, create, effects, setTime: (value: number) => { now = value; } };
}
const file = [{ name: 'story.txt', content: Buffer.from('波音の聞こえる喫茶店で。').toString('base64') }];
const throwsCode = (run: () => unknown, code: string) => assert.throws(run, (error) => error instanceof DomainError && error.code === code);

test('requests have no classification in their views or storage', () => {
  const { store, service, input, create } = setup();
  const key = randomUUID();
  const request = create({}, 'demo-client', key);
  assert.equal('genre' in request, false);
  assert.equal(store.db.prepare('PRAGMA table_info(requests)').all().some((column) => column.name === 'genre'), false);
  assert.equal('genre' in service.list('demo-client')[0]!, false);
  assert.equal('genre' in service.get('demo-creator', request.id), false);
  const legacyInput = { ...input, genre: 'text' };
  assert.equal(service.create('demo-client', key, legacyInput).id, request.id);
});

test('card: submit, accept, deliver and download', () => {
  const { service, create, effects } = setup();
  const request = create();
  assert.equal(request.state, 'awaiting_acceptance');
  assert.equal(request.paymentState, 'authorized');
  const accepted = service.accept('demo-creator', request.id, randomUUID());
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.paymentState, 'captured');
  const delivered = service.deliver('demo-creator', request.id, randomUUID(), file);
  assert.equal(delivered.state, 'delivered');
  assert.equal(Buffer.from(service.download('demo-client', delivered.files[0]!.id).data).toString(), '波音の聞こえる喫茶店で。');
  assert.equal(effects(request.id, 'capture'), 1);
  assert.equal(effects(request.id, 'sale'), 1);
});
test('points: hold is not consumption; cancellation unlocks', () => {
  const { service, create } = setup();
  const request = create({ paymentMethod: 'points' });
  assert.equal(service.session('demo-client').pointsBalance, 50000);
  assert.equal(service.session('demo-client').pointsAvailable, 38000);
  assert.equal(service.cancel('demo-client', request.id, randomUUID()).paymentState, 'released');
  assert.equal(service.session('demo-client').pointsAvailable, 50000);
});
test('points: acceptance consumes once; give-up refunds once', () => {
  const { service, create, effects } = setup();
  const { id } = create({ paymentMethod: 'points' });
  const key = randomUUID();
  service.accept('demo-creator', id, key); service.accept('demo-creator', id, key);
  assert.equal(service.session('demo-client').pointsBalance, 38000);
  service.cancel('demo-creator', id, randomUUID()); service.cancel('demo-creator', id, randomUUID());
  assert.equal(service.session('demo-client').pointsBalance, 50000);
  assert.equal(effects(id, 'refund'), 1);
});
test('outstanding point holds cannot overspend the wallet', () => {
  const { create } = setup();
  create({ paymentMethod: 'points', amount: 40000 });
  throwsCode(() => create({ paymentMethod: 'points', amount: 12000 }), 'INSUFFICIENT_POINTS');
});
test('failed authorization creates neither request nor effect', () => {
  const { create, service, store } = setup({ failAuthorization: true });
  throwsCode(() => create(), 'PAYMENT_DECLINED');
  assert.equal(service.list('demo-client').length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n, 0);
});
test('failed capture preserves the request and held balance for retry', () => {
  const { create, service, effects } = setup({ failCapture: true });
  const { id } = create({ paymentMethod: 'points' });
  throwsCode(() => service.accept('demo-creator', id, randomUUID()), 'PAYMENT_DECLINED');
  assert.equal(service.get('demo-client', id).state, 'awaiting_acceptance');
  assert.equal(service.session('demo-client').pointsBalance, 50000);
  assert.equal(effects(id, 'capture'), 0);
});
test('submission is idempotent and conflicting reuse is rejected', () => {
  const { create, service } = setup(); const key = randomUUID();
  const first = create({}, 'demo-client', key);
  assert.equal(create({}, 'demo-client', key).id, first.id);
  assert.equal(service.list('demo-client').length, 1);
  throwsCode(() => create({ amount: 13000 }, 'demo-client', key), 'KEY_REUSED');
});
test('approval does not move either deadline', () => {
  const { create, service, setTime } = setup();
  const initial = create(); setTime(1_000_999);
  const accepted = service.accept('demo-creator', initial.id, randomUUID());
  assert.equal(accepted.acceptBy, initial.acceptBy);
  assert.equal(accepted.deliverBy, initial.deliverBy);
});
test('acceptance expires at the exact deadline and releases the hold', () => {
  const { create, service, setTime } = setup(); const { id, acceptBy } = create();
  setTime(acceptBy);
  throwsCode(() => service.accept('demo-creator', id, randomUUID()), 'INVALID_STATE');
  assert.equal(service.get('demo-client', id).paymentState, 'released');
});
test('authorization can expire before the acceptance deadline', () => {
  const { create, service, store, setTime } = setup(); const { id } = create();
  store.db.prepare('UPDATE payments SET hold_until = ? WHERE request_id = ?').run(1_000_500, id);
  setTime(1_000_500);
  assert.equal(service.expire(), 1);
  assert.equal(service.get('demo-client', id).state, 'cancelled');
});
test('delivery expiry refunds captured points exactly once', () => {
  const { create, service, setTime, effects } = setup();
  const { id, deliverBy } = create({ paymentMethod: 'points' }); service.accept('demo-creator', id, randomUUID());
  setTime(deliverBy); service.expire(); service.expire();
  assert.equal(service.get('demo-client', id).paymentState, 'refunded');
  assert.equal(service.session('demo-client').pointsBalance, 50000);
  assert.equal(effects(id, 'refund'), 1);
});
test('cancel and approval races have a single winner', async () => {
  const { create, service, effects } = setup(); const { id } = create();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => service.cancel('demo-client', id, randomUUID())),
    Promise.resolve().then(() => service.accept('demo-creator', id, randomUUID())),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(effects(id, 'capture'), 0);
  const second = create(); service.accept('demo-creator', second.id, randomUUID());
  throwsCode(() => service.cancel('demo-client', second.id, randomUUID()), 'INVALID_STATE');
});
test('pending capture is not announced as accepted', () => {
  const { create, service } = setup({ deferCardCapture: true }); const { id } = create();
  assert.equal(service.accept('demo-creator', id, randomUUID()).state, 'accepting');
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), file), 'INVALID_STATE');
  service.completeMockCapture(id, 'event-success');
  assert.equal(service.get('demo-client', id).state, 'accepted');
});
test('late duplicate capture after expiry refunds without resurrecting request', () => {
  const { create, service, setTime, effects } = setup({ deferCardCapture: true }); const { id, acceptBy } = create();
  service.accept('demo-creator', id, randomUUID()); setTime(acceptBy); service.expire();
  service.completeMockCapture(id, 'late-event'); service.completeMockCapture(id, 'late-event'); service.completeMockCapture(id, 'duplicate-event');
  assert.equal(service.get('demo-client', id).state, 'cancelled');
  assert.equal(service.get('demo-client', id).paymentState, 'refunded');
  assert.equal(effects(id, 'capture'), 1); assert.equal(effects(id, 'refund'), 1);
});
test('unrequested capture is rejected and event IDs are scoped to one payment', () => {
  const { create, service } = setup({ deferCardCapture: true }); const one = create(); const two = create();
  throwsCode(() => service.completeMockCapture(one.id, 'not-approved'), 'UNEXPECTED_CAPTURE');
  service.accept('demo-creator', one.id, randomUUID()); service.completeMockCapture(one.id, 'shared-event');
  throwsCode(() => service.completeMockCapture(two.id, 'shared-event'), 'EVENT_REUSED');
});
test('creator redelivery is allowed without duplicate revenue or shifted deadlines', () => {
  const { create, service, effects } = setup(); const { id, deliverBy } = create(); service.accept('demo-creator', id, randomUUID());
  const key = randomUUID(); const first = service.deliver('demo-creator', id, key, file);
  assert.equal(service.deliver('demo-creator', id, key, file).deliveryVersion, 1);
  const second = service.deliver('demo-creator', id, randomUUID(), file);
  assert.equal(second.deliveryVersion, 2); assert.equal(second.deliverBy, deliverBy);
  assert.notEqual(first.files[0]!.id, second.files[0]!.id); assert.equal(effects(id, 'sale'), 1);
});
test('delivery is rejected before acceptance, after deadline, and without files', () => {
  const { create, service, setTime } = setup(); const { id, deliverBy } = create();
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), file), 'INVALID_STATE');
  service.accept('demo-creator', id, randomUUID());
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), []), 'INVALID_FILES');
  service.deliver('demo-creator', id, randomUUID(), file); setTime(deliverBy);
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), file), 'INVALID_STATE');
  assert.equal(service.get('demo-client', id).state, 'delivered');
});
test('strangers cannot view, approve, cancel, deliver or download a private request', () => {
  const { create, service } = setup(); const { id } = create({ visibility: 'hidden' });
  for (const run of [() => service.get('other-client', id), () => service.accept('other-creator', id, randomUUID()), () => service.cancel('other-client', id, randomUUID()), () => service.deliver('other-creator', id, randomUUID(), file)]) throwsCode(run, 'NOT_FOUND');
  throwsCode(() => service.accept('demo-client', id, randomUUID()), 'FORBIDDEN');
  service.accept('demo-creator', id, randomUUID());
  const delivery = service.deliver('demo-creator', id, randomUUID(), file);
  throwsCode(() => service.download('other-client', delivery.files[0]!.id), 'NOT_FOUND');
  assert.equal(service.publicWorks().length, 0);
});
test('anonymous requests omit client identity and public views omit money and files', () => {
  const { create, service } = setup(); const { id } = create({ visibility: 'anonymous' });
  assert.equal(service.get('demo-creator', id).clientName, '匿名の依頼者');
  assert.equal(JSON.stringify(service.list('demo-creator')).includes('demo-client'), false);
  service.accept('demo-creator', id, randomUUID()); service.deliver('demo-creator', id, randomUUID(), file);
  const view = service.publicWorks()[0]!;
  assert.equal(view.clientName, '匿名の依頼者'); assert.equal('amount' in view, false);
  assert.equal('paymentMethod' in view, false); assert.deepEqual(view.files, []);
});
test('validation rejects invalid input, unsafe names, empty and oversized files', () => {
  const { create, service } = setup();
  throwsCode(() => create({ amount: 1.5 }), 'INVALID_AMOUNT');
  throwsCode(() => create({ brief: ' ' }), 'INVALID_BRIEF');
  throwsCode(() => create({ agreeToRules: false }), 'RULES_REQUIRED');
  const { id } = create(); service.accept('demo-creator', id, randomUUID());
  for (const name of ['../secret', 'a\nb.txt', 'folder\\secret']) throwsCode(() => service.deliver('demo-creator', id, randomUUID(), [{ ...file[0]!, name }]), 'INVALID_FILE_NAME');
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), [{ name: 'empty.txt', content: '' }]), 'FILE_TOO_LARGE');
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), Array(25).fill(file[0])), 'INVALID_FILES');
});
test('SQLite persistence retains requests, holds and idempotency across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-persistence-'));
  const dbPath = join(directory, 'test.sqlite');
  let store = new Store(dbPath);
  try {
    let service = new CommissionService(store); const key = randomUUID();
    const input: RequestInput = { creatorId: 'demo-creator', brief: '物語をお願いします。', amount: 12000, paymentMethod: 'points', visibility: 'hidden', nsfw: false, agreeToRules: true };
    const first = service.create('demo-client', key, input); store.close(); store = new Store(dbPath); service = new CommissionService(store);
    assert.equal(service.create('demo-client', key, input).id, first.id);
    assert.equal(service.session('demo-client').pointsAvailable, 38000);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('file size and base64 boundaries fail atomically without a delivery or sale', () => {
  const { create, service, effects, store } = setup();
  const { id } = create(); service.accept('demo-creator', id, randomUUID());
  const maximum = service.policy.maximumUploadBytes;
  const oversized = [{ name: 'large.bin', content: Buffer.alloc(maximum + 3).toString('base64') }];
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), oversized), 'INVALID_FILE');
  const split = [maximum / 2, maximum / 2 + 1].map((length, index) => ({ name: `${index}.bin`, content: Buffer.alloc(length).toString('base64') }));
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), split), 'FILE_TOO_LARGE');
  throwsCode(() => service.deliver('demo-creator', id, randomUUID(), [{ name: 'bad.txt', content: 'abc' }]), 'INVALID_FILE');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, 0);
  assert.equal(service.get('demo-client', id).state, 'accepted'); assert.equal(effects(id, 'sale'), 0);
  const boundary = service.deliver('demo-creator', id, randomUUID(), [{ name: 'exact.bin', content: Buffer.alloc(maximum).toString('base64') }]);
  assert.equal(boundary.files[0]!.size, maximum); assert.equal(effects(id, 'sale'), 1);
});
