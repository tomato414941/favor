// Favor's HTTP server: React Router on Node's http module, with the built client assets in production.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createRequestListener } from '@remix-run/node-fetch-server';
import { createRequestHandler, RouterContextProvider } from 'react-router';

if (existsSync('.env.local')) loadEnvFile('.env.local');
// Sign-in is configured explicitly; Clerk must never create an application on its own.
process.env.CLERK_KEYLESS_DISABLED ??= 'true';
const development = process.env.NODE_ENV === 'development';
const port = Number(process.env.FAVOR_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FAVOR_PORT must be an integer from 1024 to 65535.');

let loadBuild;
let vite = null;
if (development) {
  vite = await (await import('vite')).createServer({ server: { middlewareMode: true } });
  loadBuild = () => vite.ssrLoadModule('virtual:react-router/server-build');
} else {
  const build = await import(pathToFileURL(resolve('build/server/index.js')).href);
  loadBuild = () => build;
}
const { Favor, configFromEnv } = (await loadBuild()).entry.module;
const favor = new Favor(await configFromEnv(process.env));
const handler = createRequestHandler(loadBuild, development ? 'development' : 'production');
const handle = async (request, client) => {
  const context = new RouterContextProvider();
  context.set((await loadBuild()).entry.module.favorContext, favor);
  return handler(request, context);
};

const types = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const assets = resolve('build/client/assets') + sep;
/** Hashed build output only; anything else is a page or an API answer. */
function serveAsset(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  let path;
  try {
    path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end('Bad Request');
    return true;
  }
  if (!path.startsWith('/assets/')) return false;
  const file = resolve(assets, `.${path.slice('/assets'.length)}`);
  const type = types[extname(file)];
  if (!file.startsWith(assets) || !type) return false;
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
  return true;
}

const listener = createRequestListener(handle, {
  // Behind the local reverse proxy, requests belong to the public origin.
  ...(favor.trustLoopbackProxy && favor.origin
    ? { protocol: favor.origin.protocol, host: favor.origin.host }
    : {}),
  onError(error) {
    favor.log(error instanceof Error ? error.message : 'Request failed');
    return new Response(
      JSON.stringify({ message: '処理を完了できませんでした。時間をおいてお試しください。' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  },
});
const server = createServer((request, response) => {
  if (vite) return vite.middlewares(request, response, () => listener(request, response));
  if (serveAsset(request, response)) return;
  return listener(request, response);
});
favor.start();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  await favor.stop();
  await vite?.close();
  favor.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
server.listen(port, '127.0.0.1', () => {
  console.error(`Favor is listening on http://127.0.0.1:${port}`);
});
