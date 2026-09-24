import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from '../src/server/auth.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
test('再起動後も依頼・ファイル・操作の再試行・利用者を維持する', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'favor-store-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const services = () => {
    const auth = new AuthService(store, Date.now, { allowDemo: true });
    const requests = new RequestService(store);
    return { auth, requests, links: new RequestLinkService(requests, auth) };
  };
  try {
    let { auth, requests, links } = services();
    const sender = auth.actor(auth.demoLogin('client'));
    const session = auth.demoLogin('recipient');
    const recipient = auth.identity(session).account;
    const input = {
      brief: '静かな明け方の物語をお願いします。',
      amount: 12000,
      visibility: 'hidden' as const,
      agreeToRules: true,
    };
    const createKey = randomUUID();
    const acceptKey = randomUUID();
    const deliverKey = randomUUID();
    const created = await links.create(sender, createKey, input);
    const accepted = await links.accept(recipient, created.token!, acceptKey, true);
    const actor = auth.actor(session);
    const files = [
      { name: '作品.txt', content: Buffer.from('明け方の静けさ。').toString('base64') },
    ];
    const delivered = await requests.deliver(actor, accepted.requestId!, deliverKey, files);
    store.close();
    store = new Store(path);
    ({ auth, requests, links } = services());
    // Sessions live with the identity provider; a restart keeps the user row.
    assert.equal(auth.actor(auth.demoLogin('recipient')), actor);
    assert.equal((await links.create(sender, createKey, input)).link.id, created.link.id);
    assert.equal(
      (await links.accept(recipient, created.token!, acceptKey, true)).requestId,
      accepted.requestId,
    );
    assert.deepEqual(
      await requests.deliver(actor, accepted.requestId!, deliverKey, files),
      delivered,
    );
    assert.equal(
      Buffer.from(requests.download(sender, delivered.id, delivered.files[0]!.id).data).toString(),
      '明け方の静けさ。',
    );
    assert.equal(links.read(created.token!, recipient).paymentState, 'captured');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    const next = await links.create(sender, randomUUID(), input);
    assert.equal(links.read(next.token!).state, 'pending');
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
