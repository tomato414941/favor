import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileDelivery, resendDelivery } from '../src/server/email-delivery.js';
import { hashToken } from '../src/server/auth.js';

test('確認コードを指定した送信元から本人のメールアドレスへ送信する', async () => {
  const deliver = resendDelivery(
    'test-mail-credential',
    'commission <login@example.test>',
    async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(init!.method, 'POST');
      assert.equal(init!.redirect, 'error');
      assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer test-mail-credential');
      const body = JSON.parse(String(init!.body));
      assert.deepEqual(body.to, ['recipient@example.test']);
      assert.equal(body.from, 'commission <login@example.test>');
      assert.equal(body.subject, 'commission 確認コード');
      assert.match(body.text, /01234567/);
      assert.match(body.text, /10分以内/);
      return Response.json({ id: 'delivered' });
    },
  );
  await deliver({ to: 'recipient@example.test', code: '01234567' });
});

test('メール配信サービスが失敗したときは送信失敗として扱う', async () => {
  const deliver = resendDelivery('test-mail-credential', 'login@example.test', async () =>
    Response.json({ message: 'Provider failure' }, { status: 500 }),
  );
  await assert.rejects(
    deliver({ to: 'recipient@example.test', code: '01234567' }),
    /Email delivery failed/,
  );
});

test('開発用の確認メールを本人だけが読めるファイルへ保存する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commission-mail-'));
  try {
    const deliver = fileDelivery(join(directory, 'mail'));
    const message = { to: 'recipient@example.test', code: '01234567' };
    await deliver(message);
    const path = join(directory, 'mail', `${hashToken(message.to)}.json`);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), message);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await deliver({ ...message, code: '12345678' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).code, '12345678');
  } finally {
    await rm(directory, { recursive: true });
  }
});
