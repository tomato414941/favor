import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { CommissionService } from './service.js';
import { Store } from './store.js';
import { XProvider } from './x-auth.js';

if (!process.argv.includes('--demo')) throw new Error('Run with --demo to use the local mock-payment application.');
const port = Number(process.env.COMMISSION_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COMMISSION_PORT must be an integer from 1024 to 65535.');
const authMode = process.env.COMMISSION_AUTH_MODE ?? 'demo';
if (!['demo', 'x'].includes(authMode)) throw new Error('COMMISSION_AUTH_MODE must be demo or x.');
const xProvider = authMode === 'x' ? new XProvider({
  clientId: process.env.X_CLIENT_ID ?? '', clientSecret: process.env.X_CLIENT_SECRET ?? '',
  publicOrigin: process.env.COMMISSION_PUBLIC_ORIGIN ?? '', appBearerToken: process.env.X_APP_BEARER_TOKEN,
}) : undefined;
// Keep real X identities separate from the existing demo database by default.
const store = new Store(resolve(process.env.COMMISSION_DATA_DIR ?? (authMode === 'x' ? 'data/x-sandbox' : 'data'), 'commission.sqlite'));
const service = new CommissionService(store);
const app = await buildApp(service, { logger: true, demoAuth: authMode === 'demo', xProvider });
const timer = setInterval(() => {
  try { service.expire(); } catch (error) { app.log.error(error); }
}, 1000);
timer.unref();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await app.close();
  store.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
try { await app.listen({ port, host: '127.0.0.1' }); }
catch (error) { await close(); throw error; }
