import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashToken, newToken } from './auth.js';
import type { EmailDelivery } from './email-auth.js';

export function resendDelivery(
  apiKey: string,
  from: string,
  request: typeof fetch = fetch,
): EmailDelivery {
  if (!apiKey.trim() || !from.trim() || /[\r\n]/.test(from))
    throw new Error('RESEND_API_KEY and FAVOR_EMAIL_FROM are required.');
  return async ({ to, code }) => {
    const response = await request('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Favor 確認コード',
        text: `確認コード：${code}\n\n10分以内に、メールアドレスを入力した画面へ入力してください。\n心当たりがなければ、このメールは破棄してください。`,
      }),
    });
    if (!response.ok) throw new Error('Email delivery failed.');
  };
}

/** Local development mailbox. The application entrypoint restricts this to loopback. */
export function fileDelivery(directory: string): EmailDelivery {
  return async (message) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${newToken()}.tmp`);
    await writeFile(temporary, JSON.stringify(message), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, `${hashToken(message.to)}.json`));
  };
}

/** Addresses in a reserved .test domain never reach the mail provider; staging reads their codes locally. */
export function testDomainDelivery(
  domain: string,
  local: EmailDelivery,
  remote: EmailDelivery,
): EmailDelivery {
  const suffix = `@${domain.trim().toLowerCase()}`;
  return (message) => (message.to.toLowerCase().endsWith(suffix) ? local : remote)(message);
}
