import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileDelivery, resendDelivery, testDomainDelivery } from '../src/server/email-delivery.js';
import { hashToken } from '../src/server/auth.js';
import type { EmailMessage } from '../src/server/email-auth.js';

const message = (to: string, code: string): EmailMessage => ({
  to,
  code,
  subject: 'Favor 確認コード',
  text: `確認コード：${code}\n\n10分以内に、メールアドレスを入力した画面へ入力してください。`,
});

test('件名と本文を指定した送信元から宛先へ送信する', async () => {
  const deliver = resendDelivery(
    'test-mail-credential',
    'Favor <login@example.test>',
    async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(init!.method, 'POST');
      assert.equal(init!.redirect, 'error');
      assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer test-mail-credential');
      const body = JSON.parse(String(init!.body));
      assert.deepEqual(body.to, ['recipient@example.test']);
      assert.equal(body.from, 'Favor <login@example.test>');
      assert.equal(body.subject, 'Favor 確認コード');
      assert.match(body.text, /01234567/);
      assert.match(body.text, /10分以内/);
      return Response.json({ id: 'delivered' });
    },
  );
  await deliver(message('recipient@example.test', '01234567'));
});

test('メール配信サービスが失敗したときは送信失敗として扱う', async () => {
  const deliver = resendDelivery('test-mail-credential', 'login@example.test', async () =>
    Response.json({ message: 'Provider failure' }, { status: 500 }),
  );
  await assert.rejects(
    deliver(message('recipient@example.test', '01234567')),
    /Email delivery failed/,
  );
});

test('開発用の確認メールを本人だけが読めるファイルへ保存する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'favor-mail-'));
  try {
    const deliver = fileDelivery(join(directory, 'mail'));
    const first = message('recipient@example.test', '01234567');
    await deliver(first);
    const path = join(directory, 'mail', `${hashToken(first.to)}.json`);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await deliver(message('recipient@example.test', '12345678'));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).code, '12345678');
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('予約ドメイン宛の確認コードはローカルの受信箱へ保存し、それ以外は配信サービスへ送る', async () => {
  const local: EmailMessage[] = [];
  const remote: EmailMessage[] = [];
  const deliver = testDomainDelivery(
    'Favor.test',
    async (message) => void local.push(message),
    async (message) => void remote.push(message),
  );
  await deliver(message('sample@favor.test', '01234567'));
  await deliver(message('person@example.com', '12345678'));
  await deliver(message('person@notfavor.test', '23456789'));
  assert.deepEqual(local, [message('sample@favor.test', '01234567')]);
  assert.deepEqual(remote, [
    message('person@example.com', '12345678'),
    message('person@notfavor.test', '23456789'),
  ]);
});
