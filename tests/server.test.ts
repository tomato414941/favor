import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('不正なURLに400を返し、その後のリクエストに応答する', { timeout: 15000 }, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );

  const directory = await mkdtemp(join(tmpdir(), 'favor-http-'));
  const origin = `http://127.0.0.1:${address.port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FAVOR_AUTH_MODE: 'demo',
      FAVOR_PAYMENT_MODE: 'mock',
      FAVOR_MAIL_DELIVERY: 'file',
      FAVOR_DATA_DIR: directory,
      FAVOR_PORT: String(address.port),
      FAVOR_PUBLIC_ORIGIN: origin,
      FAVOR_TRUST_PROXY: 'none',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  server.stderr.on('data', (chunk) => (logs += chunk));
  const exited = once(server, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      assert.equal(server.exitCode, null, logs);
      try {
        const response = await fetch(`${origin}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        ready = response.ok;
        await response.arrayBuffer();
      } catch {
        // Wait for the server to begin accepting connections.
      }
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, logs);
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/%', '/assets/%GG.js', '/assets/%E0%A4%A.js']) {
        const response = await fetch(`${origin}${path}`, { method });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
        const health = await fetch(`${origin}/api/health`);
        assert.equal(health.status, 200);
        await health.arrayBuffer();
      }
    }
  } finally {
    if (server.exitCode === null) server.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true });
  }
});
