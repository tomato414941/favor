import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestInput } from '../src/shared.js';
import { CommissionService, DomainError } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

test('legacy classification is removed without losing transactions or retry keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'commission-migration-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const clock = () => 1_000_000;
  const snapshot = () => Object.fromEntries(
    ['users', 'requests', 'payments', 'effects', 'commands', 'payment_events', 'files', 'audit']
      .map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
  try {
    let service = new CommissionService(store, clock, {}, { deferCardCapture: true });
    const inputs: RequestInput[] = [
      { creatorId: 'demo-creator', brief: '静かな夜の作品をお願いします。', amount: 12000, visibility: 'anonymous', paymentMethod: 'points', nsfw: false, agreeToRules: true },
      { creatorId: 'demo-creator', brief: '朝を迎える作品をお願いします。', amount: 6000, visibility: 'public', paymentMethod: 'card', nsfw: true, agreeToRules: true },
      { creatorId: 'demo-creator', brief: '海辺を感じる作品をお願いします。', amount: 3000, visibility: 'hidden', paymentMethod: 'points', nsfw: false, agreeToRules: true },
    ];
    const keys = inputs.map(() => randomUUID());
    const requests = inputs.map((input, index) => service.create('demo-client', keys[index]!, input));
    const pending = requests[0]!; const delivered = requests[1]!; const cancelled = requests[2]!;
    service.accept('demo-creator', delivered.id, randomUUID());
    service.completeMockCapture(delivered.id, 'legacy-capture-event');
    const files = [{ name: '作品.txt', content: Buffer.from('明け方の静けさ。').toString('base64') }];
    const firstDelivery = service.deliver('demo-creator', delivered.id, randomUUID(), files);
    const deliveryKey = randomUUID();
    const latestDelivery = service.deliver('demo-creator', delivered.id, deliveryKey, [{ ...files[0]!, name: '作品・完成版.txt' }]);
    service.accept('demo-creator', cancelled.id, randomUUID());
    service.cancel('demo-creator', cancelled.id, randomUUID());
    const before = snapshot();

    // Reproduce the previous schema and its flat, alphabetically ordered request fingerprints.
    store.db.exec("ALTER TABLE requests ADD COLUMN genre TEXT NOT NULL DEFAULT 'text'");
    inputs.forEach((input, index) => {
      const genre = ['text', 'music', 'advice'][index]!;
      const legacyPayload = Object.fromEntries(Object.entries({ ...input, genre }).sort(([a], [b]) => a.localeCompare(b)));
      const fingerprint = createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex');
      store.db.prepare('UPDATE requests SET genre = ? WHERE id = ?').run(genre, requests[index]!.id);
      store.db.prepare("UPDATE commands SET fingerprint = ? WHERE actor_id = 'demo-client' AND scope = 'create' AND key = ?").run(fingerprint, keys[index]!);
    });
    store.close(); store = new Store(path); service = new CommissionService(store, clock);

    assert.deepEqual(snapshot(), before);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    inputs.forEach((input, index) => {
      assert.equal(service.create('demo-client', keys[index]!, input).id, requests[index]!.id);
      assert.equal('genre' in service.get('demo-client', requests[index]!.id), false);
    });
    assert.throws(() => service.create('demo-client', keys[0]!, { ...inputs[0]!, amount: 13000 }),
      (error) => error instanceof DomainError && error.code === 'KEY_REUSED');
    assert.equal(service.session('demo-client').pointsAvailable, 38000);
    assert.equal(service.get('demo-client', cancelled.id).paymentState, 'refunded');
    for (const delivery of [firstDelivery, latestDelivery]) {
      assert.equal(Buffer.from(service.download('demo-client', delivery.files[0]!.id).data).toString(), '明け方の静けさ。');
    }
    assert.equal(service.deliver('demo-creator', delivered.id, deliveryKey, [{ ...files[0]!, name: '作品・完成版.txt' }]).deliveryVersion, 2);
    assert.deepEqual(snapshot(), before);

    // A second startup is a no-op; both existing and new requests remain usable.
    store.close(); store = new Store(path); service = new CommissionService(store, clock);
    assert.deepEqual(snapshot(), before);
    service.accept('demo-creator', pending.id, randomUUID());
    assert.equal(service.deliver('demo-creator', pending.id, randomUUID(), files).state, 'delivered');
    const created = service.create('demo-client', randomUUID(), inputs[0]!);
    assert.equal(created.state, 'awaiting_acceptance');
    assert.equal('genre' in created, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
