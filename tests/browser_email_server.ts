/** Isolated HTTPS browser fixture. Never included in the application build. */
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { fileDelivery } from '../src/server/email-delivery.js';
import { FavorService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';

const directory = process.env.FAVOR_DATA_DIR;
const port = Number(process.env.FAVOR_PORT);
if (!directory || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('An isolated directory and port are required.');
const store = new Store(join(directory, 'favor.sqlite'));
const app = await buildApp(new FavorService(store), {
  emailDelivery: fileDelivery(join(directory, 'mail')),
  publicOrigin: process.env.FAVOR_PUBLIC_ORIGIN,
});
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
