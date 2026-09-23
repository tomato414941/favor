import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/server/auth.js';
import { LocalAuth } from '../src/server/local-auth.js';
import { CommissionService } from '../src/server/service.js';
import { RequestLinkService } from '../src/server/request-links.js';
import { Store } from '../src/server/store.js';

const password = 'private-email-test-password';
const input = {
  brief: '創作の依頼内容です。',
  amount: 12000,
  visibility: 'public' as const,
  nsfw: false,
  agreeToRules: true,
};
test('メールアドレスを本人だけに表示し、依頼相手と公開作品には公開用の名前を表示する', async () => {
  const store = new Store();
  const service = new CommissionService(store);
  const auth = new AuthService(store, Date.now, { allowLocal: true });
  const local = new LocalAuth(auth);
  const links = new RequestLinkService(service, auth);
  try {
    const sender = await local.register({
      email: 'Sender+Art@Example.test',
      password,
      agreeToRules: true,
    });
    const receiver = await local.register({
      email: 'receiver@example.test',
      password,
      agreeToRules: true,
    });
    const senderIdentity = auth.identity(sender);
    const receiverIdentity = auth.identity(receiver);
    assert.equal(senderIdentity.email, 'sender+art@example.test');
    assert.equal(receiverIdentity.email, 'receiver@example.test');
    assert.match(senderIdentity.account.name, /^ユーザー [a-f0-9]{8}$/);
    assert.notEqual(senderIdentity.account.name, receiverIdentity.account.name);
    const created = links.create(auth.actor(sender), randomUUID(), input);
    const shared = links.read(created.token!);
    assert.equal(shared.clientName, senderIdentity.account.name);
    const accepted = links.accept(receiverIdentity.account, created.token!, randomUUID(), true);
    const request = service.get(auth.actor(sender), accepted.requestId!);
    assert.equal(request.clientName, senderIdentity.account.name);
    assert.equal(request.creatorName, receiverIdentity.account.name);
    service.deliver(auth.actor(receiver), request.id, randomUUID(), [
      { name: '作品.txt', content: Buffer.from('完成した作品').toString('base64') },
    ]);
    const publicWork = service.publicWorks().find((item) => item.id === request.id)!;
    assert.equal(publicWork.clientName, senderIdentity.account.name);
    assert.equal(publicWork.creatorName, receiverIdentity.account.name);
    for (const email of [senderIdentity.email!, receiverIdentity.email!]) {
      assert.equal(JSON.stringify([shared, accepted, request, publicWork]).includes(email), false);
    }
  } finally {
    store.close();
  }
});
