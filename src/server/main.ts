import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { CommissionService } from './service.js';
import { Store } from './store.js';

if (!process.argv.includes('--demo')) throw new Error('Run with --demo to use the local mock-payment application.');
const port = Number(process.env.COMMISSION_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COMMISSION_PORT must be an integer from 1024 to 65535.');
const store = new Store(resolve(process.env.COMMISSION_DATA_DIR ?? 'data', 'commission.sqlite'));
const service = new CommissionService(store);
const app = await buildApp(service, { logger: true, demoAuth: true });
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
