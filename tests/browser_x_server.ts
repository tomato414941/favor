/** Isolated browser-test fixture. Never imported by the application entrypoint. */
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { FavorService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { XProvider, X_SCOPES } from '../src/server/x-auth.js';

const port = Number(process.env.FAVOR_PORT);
const directory = process.env.FAVOR_DATA_DIR;
if (!directory || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('An isolated test directory and port are required.');
const profiles: Record<string, { id: string; username: string; name: string }> = {
  sender: { id: '1234567890123456789', username: 'aoba_fixture', name: '青葉' },
  recipient: { id: '9876543210987654321', username: 'mio_fixture', name: '澪' },
  other: { id: '1111111111111111111', username: 'sora_fixture', name: '空' },
};
const provider = new XProvider(
  {
    clientId: 'browser-fixture-client',
    clientSecret: 'browser-fixture-secret',
    publicOrigin: `http://127.0.0.1:${port}`,
  },
  async (url, init) => {
    if (url === 'https://api.x.com/2/oauth2/token') {
      const persona = new URLSearchParams(String(init.body)).get('code') ?? '';
      if (!profiles[persona]) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        token_type: 'bearer',
        scope: X_SCOPES,
        access_token: `browser-fixture-${persona}`,
        expires_in: 7200,
      });
    }
    if (url === 'https://api.x.com/2/users/me') {
      const persona =
        new Headers(init.headers).get('Authorization')?.replace('Bearer browser-fixture-', '') ??
        '';
      return Response.json({ data: profiles[persona] });
    }
    return Response.json({ errors: [] }, { status: 404 });
  },
);
const store = new Store(join(directory, 'favor.sqlite'));
const app = await buildApp(new FavorService(store), { xProvider: provider });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  store.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await app.listen({ port, host: '127.0.0.1' });
