import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(tmpdir(), 'favor-e2e-data-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const server = spawn(process.execPath, ['dist/server/server/main.js'], {
  env: { ...process.env, FAVOR_PAYMENT_MODE: 'mock', FAVOR_AUTH_MODE: 'demo', NODE_ENV: 'test', FAVOR_MAIL_DELIVERY: 'file', FAVOR_DATA_DIR: directory, FAVOR_PORT: String(port),
    FAVOR_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, FAVOR_TRUST_PROXY: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (chunk) => { logs += chunk; });
server.stderr.on('data', (chunk) => { logs += chunk; });
let launchError;
server.on('error', (error) => { launchError = error; });
let browser;
const stop = () => { browser?.kill('SIGTERM'); server.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw new Error(`Demo server exited: ${logs}`);
    try { ready = (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Starting. */ }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error(`Demo server did not start: ${logs}`);
  browser = spawn('python3', ['tests/browser.py', url], { stdio: 'inherit', env: { ...process.env, PYTHONUNBUFFERED: '1', FAVOR_TEST_MAIL_DIR: join(directory, 'mail') } });
  const [code] = await once(browser, 'exit');
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
  // Only remove the unique database directory created by this invocation.
  await rm(directory, { recursive: true });
}
