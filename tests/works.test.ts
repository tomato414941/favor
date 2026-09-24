import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Visibility } from '../src/shared.js';
import { buildApp } from '../src/server/app.js';
import { AuthService } from '../src/server/auth.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

const notFound = (error: unknown) => error instanceof DomainError && error.code === 'NOT_FOUND';
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const files = (image: string) => [
  { name: image, content: png },
  { name: 'メモ.txt', content: Buffer.from('制作メモ').toString('base64') },
];

test('公開設定の納品済み依頼を作品として公開し、最新版の画像だけをログインなしで配信する', async () => {
  const store = new Store();
  const service = new CommissionService(store);
  const auth = new AuthService(store, Date.now, { allowDemo: true });
  auth.demoLogin('client');
  const recipient = auth.identity(auth.demoLogin('creator')).account;
  const links = new RequestLinkService(service, auth);
  const make = (visibility: Visibility) => {
    const link = links.create('demo-client', randomUUID(), {
      brief: `${visibility}の依頼`,
      amount: 12000,
      visibility,
      agreeToRules: true,
    });
    return links.accept(recipient, link.token!, randomUUID(), true).requestId!;
  };
  const shown = make('public');
  const hidden = make('hidden');
  const anonymous = make('anonymous');
  assert.throws(() => service.publicWork(shown), notFound);
  for (const id of [shown, hidden, anonymous])
    service.deliver('demo-creator', id, randomUUID(), files('絵.png'));

  const ids = service.publicWorks().map((work) => work.id);
  assert.deepEqual(ids.sort(), [shown, anonymous].sort());
  const work = service.publicWork(shown);
  assert.equal(work.brief, 'publicの依頼');
  assert.equal(work.clientName, '青葉 / aoba');
  assert.equal(work.files.length, 2);
  assert.equal('amount' in work, false);
  assert.equal(service.publicWork(anonymous).clientName, '匿名の依頼者');
  assert.throws(() => service.publicWork(hidden), notFound);

  const image = work.files.find((file) => file.name === '絵.png')!;
  const text = work.files.find((file) => file.name === 'メモ.txt')!;
  assert.equal(service.publicImage(shown, image.id).type, 'image/png');
  assert.throws(() => service.publicImage(shown, text.id), notFound);
  const hiddenImage = service.get('demo-creator', hidden).files[0]!;
  assert.throws(() => service.publicImage(hidden, hiddenImage.id), notFound);
  assert.throws(() => service.publicImage(anonymous, image.id), notFound);

  service.deliver('demo-creator', shown, randomUUID(), files('完成.PNG'));
  assert.throws(() => service.publicImage(shown, image.id), notFound);
  const latest = service.publicWork(shown).files.find((file) => file.name === '完成.PNG')!;
  assert.equal(service.publicImage(shown, latest.id).type, 'image/png');

  const app = await buildApp(service, { demoAuth: true });
  try {
    const list = await app.inject('/api/works');
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().works.some((item: { id: string }) => item.id === shown));
    const page = await app.inject(`/api/works/${shown}`);
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().brief, 'publicの依頼');
    const served = await app.inject(`/api/works/${shown}/files/${latest.id}`);
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['content-disposition'], 'inline');
    assert.match(String(served.headers['content-security-policy']), /sandbox/);
    assert.equal(served.rawPayload.toString('base64'), png);
    assert.equal((await app.inject(`/api/works/${hidden}`)).statusCode, 404);
    assert.equal((await app.inject(`/api/works/${shown}/files/${text.id}`)).statusCode, 404);
    assert.equal((await app.inject(`/api/requests/${shown}/files/${latest.id}`)).statusCode, 401);
  } finally {
    await app.close();
    store.close();
  }
});
