import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import type { EmailDelivery } from '../src/server/email-delivery.js';
import type { RequestService } from '../src/server/service.js';

// HTTP tests run against the built application, exactly as the server entrypoint does.
type Entry = typeof import('../app/entry.server');
const build = (await import(pathToFileURL(resolve('build/server/index.js')).href)) as ServerBuild;
const entry = build.entry.module as unknown as Entry;
const handler = createRequestHandler(build, 'production');

export interface Call {
  method?: string;
  headers?: Record<string, string>;
  cookie?: string;
  /** A JSON body for the machine API. */
  json?: unknown;
  /** A form submission to a page action. */
  form?: Record<string, string> | FormData;
  body?: BodyInit;
}
export async function serve(
  service: RequestService,
  options: { mail?: EmailDelivery; publicOrigin?: string } = {},
) {
  const favor = new entry.Favor({
    service,
    auth: 'demo',
    ...(options.mail ? { mail: options.mail } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
  const origin = options.publicOrigin ?? 'http://localhost';
  async function request(path: string, call: Call = {}): Promise<Response> {
    const headers = new Headers(call.headers);
    if (call.cookie) headers.set('cookie', call.cookie);
    let body = call.body;
    if (call.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(call.json);
    } else if (call.form instanceof FormData) body = call.form;
    else if (call.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = new URLSearchParams(call.form).toString();
    }
    const method = call.method ?? (body === undefined ? 'GET' : 'POST');
    const url = /^https?:/.test(path) ? path : `${origin}${path}`;
    const context = new RouterContextProvider();
    context.set(entry.favorContext, favor);
    return handler(
      new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }),
      context,
    );
  }
  /** Signs in by address and returns the cookie to send back. */
  async function login(email: string): Promise<string> {
    const response = await request('/login', { form: { email, stay: '1' } });
    if (response.status !== 200) throw new Error(`Login failed: ${response.status}`);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  return { favor, request, login, close: () => favor.stop() };
}
