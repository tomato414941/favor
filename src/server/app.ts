import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InvitationInput, RequestInput, UploadInput } from '../shared.js';
import { CommissionService, DomainError } from './service.js';
import { AuthService, isToken, type DemoPersona } from './auth.js';
import { InvitationService } from './invitations.js';
import { normalizeXHandle, XAuth, XProvider } from './x-auth.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export async function buildApp(service: CommissionService, options: { staticRoot?: string; logger?: boolean; demoAuth?: boolean; xProvider?: XProvider } = {}) {
  if (options.demoAuth && options.xProvider) throw new Error('Demo and X authentication cannot be enabled together.');
  // OAuth query strings and invitation headers must not enter request logs.
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 12 * 1024 * 1024 });
  const auth = new AuthService(service.store, service.clock, { allowDemo: options.demoAuth === true, allowX: Boolean(options.xProvider) });
  const x = options.xProvider ? new XAuth(auth, options.xProvider) : null;
  const publicOrigin = options.xProvider?.publicOrigin;
  const sessionCookie = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 86400, secure: options.xProvider?.secureCookies ?? false };
  const flowCookie = { httpOnly: true, sameSite: 'lax' as const, path: '/api/auth', maxAge: 600, secure: sessionCookie.secure };
  const invitations = new InvitationService(service, auth);
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    if ((publicOrigin && new URL(publicOrigin).host !== request.headers.host) || (!publicOrigin && !['localhost', '127.0.0.1'].includes(request.hostname))) return reply.code(403).send({ message: 'アクセス先のURLを確認してください。' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-commission-action'] !== '1') return reply.code(403).send({ message: '操作を確認できませんでした。' });
      const origin = request.headers.origin;
      if (origin) {
        const allowed = publicOrigin ? [publicOrigin] : [`http://${request.headers.host}`, 'http://localhost:3211', 'http://127.0.0.1:3211'];
        if (!allowed.includes(origin)) return reply.code(403).send({ message: 'この送信元からは操作できません。' });
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ message: 'この送信元からは操作できません。' });
    }
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/') || request.url === '/') reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error.validation || (error.statusCode && error.statusCode < 500)) return reply.code(error.statusCode ?? 400).send({ message: '入力内容または送信形式を確認してください。' });
    app.log.error({ code: error.code }, 'Request failed');
    return reply.code(500).send({ message: '処理を完了できませんでした。時間をおいてお試しください。' });
  });
  const actor = (request: FastifyRequest): string => auth.actor(request.cookies.commission_session);
  const identity = (request: FastifyRequest) => auth.identity(request.cookies.commission_session);
  const invitationToken = (request: FastifyRequest): string => typeof request.headers['x-commission-invitation'] === 'string' ? request.headers['x-commission-invitation'] : '';
  const login = (request: FastifyRequest, reply: FastifyReply, persona: DemoPersona) => {
    auth.logout(request.cookies.commission_session);
    const token = auth.demoLogin(persona);
    reply.setCookie('commission_session', token, sessionCookie);
    return token;
  };
  const key = (request: FastifyRequest): string => typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : '';
  app.get('/api/health', async () => ({ ok: true, mode: 'demo', demoAuth: options.demoAuth === true }));
  app.get('/api/auth/options', async () => ({ mode: x ? 'x' : options.demoAuth ? 'demo' : 'disabled', xLogin: Boolean(x), invitationLookup: options.demoAuth === true || Boolean(x?.provider.lookupEnabled) }));
  if (x) {
    app.post('/api/auth/x/start', { schema: { body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request, reply) => {
      const flow = x.start(request.ip, request.cookies.commission_oauth, request.cookies.commission_session);
      reply.setCookie('commission_oauth', flow.browser, flowCookie);
      return { url: flow.url };
    });
    app.get<{ Querystring: Record<string, unknown> }>('/api/auth/x/callback', { exposeHeadRoute: false }, async (request, reply) => {
      let outcome = 'success';
      try {
        const token = await x.finish(request.cookies.commission_oauth, request.query);
        reply.setCookie('commission_session', token, sessionCookie);
      } catch (error) {
        outcome = error instanceof DomainError && error.code === 'OAUTH_CANCELLED' ? 'cancelled'
          : error instanceof DomainError && error.code === 'OAUTH_EXPIRED' ? 'expired' : 'failed';
      }
      if (outcome !== 'expired') reply.clearCookie('commission_oauth', flowCookie);
      const flow = isToken(request.query.state) ? `&flow=${request.query.state}` : '';
      return reply.redirect(`${publicOrigin}/#auth=${outcome}${flow}`, 303);
    });
  }
  app.get('/api/creator', async () => ({ creator: service.creator(), limits: { brief: service.policy.maximumBriefLength, files: service.policy.maximumFiles, uploadBytes: service.policy.maximumUploadBytes, maximumAmount: service.policy.maximumAmount } }));
  if (options.demoAuth === true) {
    app.get('/api/demo/session', async (request) => {
      try { return service.session(actor(request)); }
      catch (error) { if (error instanceof DomainError && error.statusCode === 401) return null; throw error; }
    });
    app.post<{ Body: { role: 'client' | 'creator' } }>('/api/demo/session', {
      schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: ['client', 'creator'] } } } },
    }, async (request, reply) => {
      return service.session(auth.actor(login(request, reply, request.body.role)));
    });
    app.post<{ Body: { persona: 'recipient' | 'other' } }>('/api/demo/identity', {
      schema: { body: { type: 'object', required: ['persona'], additionalProperties: false, properties: { persona: { enum: ['recipient', 'other'] } } } },
    }, async (request, reply) => auth.identity(login(request, reply, request.body.persona)));
  }
  app.get('/api/auth/identity', async (request) => {
    try { return identity(request); }
    catch (error) { if (error instanceof DomainError && error.statusCode === 401) return null; throw error; }
  });
  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies.commission_session);
    x?.cancel(request.cookies.commission_oauth);
    reply.clearCookie('commission_session', sessionCookie);
    reply.clearCookie('commission_oauth', flowCookie);
    return { ok: true };
  });
  app.post<{ Body: { agreeToRules: boolean } }>('/api/auth/register', {
    schema: { body: { type: 'object', required: ['agreeToRules'], additionalProperties: false, properties: { agreeToRules: { const: true } } } },
  }, async (request) => service.session(auth.registerAccount(request.cookies.commission_session, request.body.agreeToRules)));
  app.get('/api/invitations', async (request) => ({ invitations: invitations.list(actor(request)) }));
  if (options.demoAuth === true || x) {
    app.post<{ Body: InvitationInput }>('/api/invitations', {
      schema: { body: { type: 'object', additionalProperties: false,
        required: ['recipientHandle', 'brief', 'amount', 'visibility', 'nsfw', 'agreeToRules'], properties: {
          recipientHandle: { type: 'string', minLength: 1, maxLength: 100 },
          brief: { type: 'string', minLength: 1, maxLength: service.policy.maximumBriefLength },
          amount: { type: 'integer', minimum: service.policy.minimumAmount, maximum: service.policy.maximumAmount },
          visibility: { enum: ['public', 'anonymous', 'hidden'] }, nsfw: { type: 'boolean' }, agreeToRules: { const: true },
        } } },
    }, async (request, reply) => {
      const user = actor(request);
      if (x) {
        const input = { ...request.body, recipientHandle: normalizeXHandle(request.body.recipientHandle) };
        return reply.code(201).send(await invitations.createWithLookup(user, key(request), input, () => {
          x.limit(`lookup:${user}`, 30);
          return x.provider.lookup(input.recipientHandle);
        }));
      }
      const recipient = auth.resolveDemoRecipient(request.body.recipientHandle);
      return reply.code(201).send(invitations.create(user, key(request), request.body, recipient));
    });
  }
  app.post<{ Params: { id: string } }>('/api/invitations/:id/reissue', async (request) => invitations.reissue(actor(request), request.params.id, key(request)));
  app.post<{ Params: { id: string } }>('/api/invitations/:id/withdraw', async (request) => invitations.withdraw(actor(request), request.params.id, key(request)));
  app.get('/api/invitation', async (request) => invitations.read(identity(request).account, invitationToken(request)));
  app.post<{ Body: { agreeToRules: boolean } }>('/api/invitation/accept', {
    schema: { body: { type: 'object', required: ['agreeToRules'], additionalProperties: false, properties: { agreeToRules: { const: true } } } },
  }, async (request) => invitations.accept(identity(request).account, invitationToken(request), key(request), request.body.agreeToRules));
  app.post('/api/invitation/decline', async (request) => invitations.decline(identity(request).account, invitationToken(request), key(request)));
  app.get('/api/invitation-preference', async (request) => invitations.preference(identity(request).account));
  app.post<{ Body: { blocked: boolean } }>('/api/invitation-preference', {
    schema: { body: { type: 'object', required: ['blocked'], additionalProperties: false, properties: { blocked: { type: 'boolean' } } } },
  }, async (request) => invitations.setPreference(identity(request).account, request.body.blocked));
  const expirationTimer = setInterval(() => {
    try { invitations.expire(); x?.cleanup(); } catch { app.log.error('Expiration failed'); }
  }, 1000);
  expirationTimer.unref();
  app.addHook('onClose', async () => { clearInterval(expirationTimer); });
  app.get('/api/session', async (request) => service.session(actor(request)));
  app.get('/api/requests', async (request) => ({ requests: service.list(actor(request)) }));
  app.get('/api/works', async () => ({ works: service.publicWorks() }));
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request) => service.get(actor(request), request.params.id));
  app.post<{ Body: RequestInput }>('/api/requests', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['creatorId', 'brief', 'amount', 'visibility', 'paymentMethod', 'nsfw', 'agreeToRules'],
      properties: {
        creatorId: { type: 'string', maxLength: 100 },
        brief: { type: 'string', minLength: 1, maxLength: service.policy.maximumBriefLength },
        amount: { type: 'integer', minimum: service.policy.minimumAmount, maximum: service.policy.maximumAmount },
        visibility: { enum: ['public', 'anonymous', 'hidden'] }, paymentMethod: { enum: ['card', 'points'] },
        nsfw: { type: 'boolean' }, agreeToRules: { const: true },
      } } },
  }, async (request, reply) => reply.code(201).send(service.create(actor(request), key(request), request.body)));
  app.post<{ Params: { id: string } }>('/api/requests/:id/accept', async (request) => service.accept(actor(request), request.params.id, key(request)));
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', async (request) => service.cancel(actor(request), request.params.id, key(request)));
  app.post<{ Params: { id: string }; Body: { files: UploadInput[] } }>('/api/requests/:id/deliver', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['files'], properties: {
      files: { type: 'array', minItems: 1, maxItems: service.policy.maximumFiles, items: {
        type: 'object', required: ['name', 'content'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 180 }, content: { type: 'string', maxLength: 12 * 1024 * 1024 } },
      } },
    } } },
  }, async (request) => service.deliver(actor(request), request.params.id, key(request), request.body.files));
  app.get<{ Params: { id: string } }>('/api/files/:id', async (request, reply) => {
    const file = service.download(actor(request), request.params.id);
    const encodedName = encodeURIComponent(file.name).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`);
    return reply.header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName}`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .type('application/octet-stream').send(Buffer.from(file.data));
  });
  const root = options.staticRoot ?? resolve('dist/client');
  if (existsSync(resolve(root, 'index.html'))) {
    await app.register(staticFiles, { root, index: ['index.html'], dotfiles: 'deny' });
  }
  return app;
}
