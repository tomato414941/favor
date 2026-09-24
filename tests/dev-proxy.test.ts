import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createProbe } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ProxyOptions } from 'vite';
import viteConfig from '../vite.config.js';
import { buildApp } from '../src/server/app.js';
import { RequestService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { XProvider, X_SCOPES } from '../src/server/x-auth.js';

test('development proxy preserves the browser host, OAuth callback and CSRF origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'favor-proxy-test-'));
  const probe = createProbe();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const store = new Store();
  const provider = new XProvider(
    { clientId: 'fixture-client', clientSecret: 'fixture-secret', publicOrigin: origin },
    async (url) => {
      if (url.endsWith('/token'))
        return Response.json({
          token_type: 'bearer',
          scope: X_SCOPES,
          access_token: 'fixture-token',
        });
      return Response.json({
        data: { id: '1234567890123456789', username: 'fixture_user', name: '検証用利用者' },
      });
    },
  );
  const app = await buildApp(new RequestService(store), { xProvider: provider });
  let web: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const apiOrigin = await app.listen({ port: 0, host: '127.0.0.1' });
    const configuredProxy = viteConfig.server!.proxy!['/api/'] as ProxyOptions;
    assert.equal(configuredProxy.changeOrigin, false);
    web = await createServer({
      ...viteConfig,
      configFile: false,
      cacheDir: join(directory, 'vite-cache'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        ...viteConfig.server,
        port,
        hmr: false,
        watch: null,
        proxy: { '/api/': { ...configuredProxy, target: apiOrigin } },
      },
    });
    await web.listen();
    const options = await fetch(`${origin}/api/auth/options`);
    assert.equal(options.status, 200);
    assert.deepEqual(await options.json(), { mode: 'x', xLogin: true });
    const headers = {
      'Content-Type': 'application/json',
      'X-Favor-Action': '1',
      Origin: origin,
    };
    const response = await fetch(`${origin}/api/auth/x/start`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(response.status, 200);
    const { url } = (await response.json()) as { url: string };
    const authorize = new URL(url);
    assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/api/auth/x/callback`);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const callback = await fetch(
      `${origin}/api/auth/x/callback?${new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'fixture-code' })}`,
      {
        headers: { Cookie: cookie },
        redirect: 'manual',
      },
    );
    assert.equal(callback.status, 303);
    assert.ok(callback.headers.get('location')!.startsWith(`${origin}/#auth=success`));
    assert.ok(callback.headers.getSetCookie().some((entry) => entry.startsWith('favor_session=')));
    assert.equal(
      (
        await fetch(`${origin}/api/auth/x/start`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${origin}/api/demo/session`)).status, 404);
  } finally {
    await web?.close();
    await app.close();
    store.close();
    // Only remove the unique test cache created by this test.
    await rm(directory, { recursive: true });
  }
});
