import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RequestLinkInput, UploadInput } from '../shared.js';
import { CommissionService, DomainError } from './service.js';
import { AuthService, isToken, type DemoPersona } from './auth.js';
import { RequestLinkService } from './request-links.js';
import { XAuth, XProvider } from './x-auth.js';
import { EmailAuth, type EmailDelivery } from './email-auth.js';
import { parsePublicOrigin } from './public-origin.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

interface AppOptions {
  staticRoot?: string;
  logger?: boolean;
  demoAuth?: boolean;
  emailDelivery?: EmailDelivery;
  xProvider?: XProvider;
  publicOrigin?: string;
  trustLoopbackProxy?: boolean;
}

export async function buildApp(service: CommissionService, options: AppOptions = {}) {
  if (options.demoAuth && options.xProvider)
    throw new Error('Demo and X authentication cannot be enabled together.');
  const configuredOrigin = options.publicOrigin ?? options.xProvider?.publicOrigin;
  const origin = configuredOrigin === undefined ? undefined : parsePublicOrigin(configuredOrigin);
  const publicOrigin = origin?.origin;
  if (options.xProvider && publicOrigin !== options.xProvider.publicOrigin)
    throw new Error('The application and X callback origins must match.');
  if (options.demoAuth && origin && !['localhost', '127.0.0.1'].includes(origin.hostname))
    throw new Error('Demo authentication is allowed only on loopback.');
  if (options.trustLoopbackProxy && !origin)
    throw new Error('COMMISSION_PUBLIC_ORIGIN is required when trusting the loopback proxy.');
  // OAuth query strings and private link headers must not enter request logs.
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: options.trustLoopbackProxy ? ['127.0.0.1', '::1'] : false,
  });
  const auth = new AuthService(service.store, service.clock, {
    allowDemo: options.demoAuth === true,
    allowX: Boolean(options.xProvider),
    allowEmail: Boolean(options.emailDelivery),
  });
  const email = options.emailDelivery ? new EmailAuth(auth, options.emailDelivery) : null;
  const x = options.xProvider ? new XAuth(auth, options.xProvider) : null;
  const secureCookies = origin?.protocol === 'https:';
  // The browser rejects parent-domain cookies with a __Host- prefix.
  const sessionCookieName = secureCookies ? '__Host-commission_session' : 'commission_session';
  const emailCookieName = secureCookies ? '__Host-commission_email' : 'commission_email';
  const flowCookieName = secureCookies ? '__Host-commission_oauth' : 'commission_oauth';
  const sessionCookie = {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 86400,
    secure: secureCookies,
  };
  const flowCookie = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: secureCookies ? '/' : '/api/auth',
    maxAge: 600,
    secure: secureCookies,
  };
  const links = new RequestLinkService(service, auth);
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    if (
      (origin && origin.host !== request.headers.host) ||
      (!origin && !['localhost', '127.0.0.1'].includes(request.hostname))
    )
      return reply.code(403).send({ message: 'アクセス先のURLを確認してください。' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-commission-action'] !== '1')
        return reply.code(403).send({ message: '操作を確認できませんでした。' });
      const origin = request.headers.origin;
      if (origin) {
        const allowed = publicOrigin
          ? [publicOrigin]
          : [`http://${request.headers.host}`, 'http://localhost:3211', 'http://127.0.0.1:3211'];
        if (!allowed.includes(origin))
          return reply.code(403).send({ message: 'この送信元からは操作できません。' });
      }
      if (request.headers['sec-fetch-site'] === 'cross-site')
        return reply.code(403).send({ message: 'この送信元からは操作できません。' });
    }
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/') || request.url === '/')
      reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error.validation || (error.statusCode && error.statusCode < 500))
      return reply
        .code(error.statusCode ?? 400)
        .send({ message: '入力内容または送信形式を確認してください。' });
    app.log.error({ code: error.code }, 'Request failed');
    return reply
      .code(500)
      .send({ message: '処理を完了できませんでした。時間をおいてお試しください。' });
  });
  const actor = (request: FastifyRequest): string => auth.actor(request.cookies[sessionCookieName]);
  const identity = (request: FastifyRequest) => auth.identity(request.cookies[sessionCookieName]);
  const optionalAccount = (request: FastifyRequest) => {
    try {
      return identity(request).account;
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 401) return undefined;
      throw error;
    }
  };
  const login = (request: FastifyRequest, reply: FastifyReply, persona: DemoPersona) => {
    auth.logout(request.cookies[sessionCookieName]);
    const token = auth.demoLogin(persona);
    reply.setCookie(sessionCookieName, token, sessionCookie);
    return token;
  };
  const key = (request: FastifyRequest): string =>
    typeof request.headers['idempotency-key'] === 'string'
      ? request.headers['idempotency-key']
      : '';
  app.get('/api/health', async () => ({
    ok: true,
    mode: 'demo',
    demoAuth: options.demoAuth === true,
  }));
  app.get('/api/auth/options', async () => ({
    mode: x ? 'x' : options.demoAuth ? 'demo' : email ? 'email' : 'disabled',
    xLogin: Boolean(x),
    ...(email ? { emailLogin: true } : {}),
  }));
  if (email) {
    app.post<{ Body: { email: string } }>(
      '/api/auth/email/start',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['email'],
            properties: { email: { type: 'string', minLength: 1, maxLength: 254 } },
          },
        },
      },
      async (request, reply) => {
        auth.limit(`email-start:${request.ip}`);
        const challenge = await email.start(request.body.email, request.cookies[emailCookieName]);
        reply.setCookie(emailCookieName, challenge, { ...sessionCookie, maxAge: 600 });
        return { ok: true };
      },
    );
    app.post<{ Body: { code: string } }>(
      '/api/auth/email/verify',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['code'],
            properties: { code: { type: 'string', maxLength: 64 } },
          },
        },
      },
      async (request, reply) => {
        auth.limit(`email-verify:${request.ip}`, 30);
        const token = email.verify(
          request.cookies[emailCookieName],
          request.body.code,
          request.cookies[sessionCookieName],
        );
        reply.clearCookie(emailCookieName, sessionCookie);
        reply.setCookie(sessionCookieName, token, sessionCookie);
        return auth.identity(token);
      },
    );
  }
  if (x) {
    app.post(
      '/api/auth/x/start',
      { schema: { body: { type: 'object', additionalProperties: false, maxProperties: 0 } } },
      async (request, reply) => {
        const flow = x.start(
          request.ip,
          request.cookies[flowCookieName],
          request.cookies[sessionCookieName],
        );
        reply.setCookie(flowCookieName, flow.browser, flowCookie);
        return { url: flow.url };
      },
    );
    app.get<{ Querystring: Record<string, unknown> }>(
      '/api/auth/x/callback',
      { exposeHeadRoute: false },
      async (request, reply) => {
        let outcome = 'success';
        try {
          const token = await x.finish(request.cookies[flowCookieName], request.query);
          reply.setCookie(sessionCookieName, token, sessionCookie);
        } catch (error) {
          outcome =
            error instanceof DomainError && error.code === 'OAUTH_CANCELLED'
              ? 'cancelled'
              : error instanceof DomainError && error.code === 'OAUTH_EXPIRED'
                ? 'expired'
                : 'failed';
        }
        if (outcome !== 'expired') reply.clearCookie(flowCookieName, flowCookie);
        const flow = isToken(request.query.state) ? `&flow=${request.query.state}` : '';
        return reply.redirect(`${publicOrigin}/#auth=${outcome}${flow}`, 303);
      },
    );
  }
  app.get('/api/request-settings', async () => ({
    terms: {
      recommendedAmount: service.policy.recommendedAmount,
      minimumAmount: service.policy.minimumAmount,
      acceptanceDays:
        Math.min(
          service.policy.acceptanceMs,
          service.policy.authorizationMs,
          service.policy.deliveryMs,
        ) / 86_400_000,
      deliveryDays: service.policy.deliveryMs / 86_400_000,
    },
    limits: {
      brief: service.policy.maximumBriefLength,
      files: service.policy.maximumFiles,
      uploadBytes: service.policy.maximumUploadBytes,
      maximumAmount: service.policy.maximumAmount,
    },
  }));
  if (options.demoAuth === true) {
    app.get('/api/demo/session', async (request) => {
      try {
        return service.session(actor(request));
      } catch (error) {
        if (error instanceof DomainError && error.statusCode === 401) return null;
        throw error;
      }
    });
    app.post<{ Body: { role: 'client' | 'creator' } }>(
      '/api/demo/session',
      {
        schema: {
          body: {
            type: 'object',
            required: ['role'],
            additionalProperties: false,
            properties: { role: { enum: ['client', 'creator'] } },
          },
        },
      },
      async (request, reply) => {
        return service.session(auth.actor(login(request, reply, request.body.role)));
      },
    );
    app.post<{ Body: { persona: 'recipient' | 'other' } }>(
      '/api/demo/identity',
      {
        schema: {
          body: {
            type: 'object',
            required: ['persona'],
            additionalProperties: false,
            properties: { persona: { enum: ['recipient', 'other'] } },
          },
        },
      },
      async (request, reply) => auth.identity(login(request, reply, request.body.persona)),
    );
  }
  app.get('/api/auth/identity', async (request) => {
    try {
      return identity(request);
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 401) return null;
      throw error;
    }
  });
  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies[sessionCookieName]);
    email?.cancel(request.cookies[emailCookieName]);
    x?.cancel(request.cookies[flowCookieName]);
    reply.clearCookie(emailCookieName, sessionCookie);
    reply.clearCookie(sessionCookieName, sessionCookie);
    reply.clearCookie(flowCookieName, flowCookie);
    return { ok: true };
  });
  app.post(
    '/api/auth/register',
    { schema: { body: { type: 'object', additionalProperties: false, maxProperties: 0 } } },
    async (request) => service.session(auth.registerAccount(request.cookies[sessionCookieName])),
  );
  const linkToken = (request: FastifyRequest): string =>
    typeof request.headers['x-commission-link'] === 'string'
      ? request.headers['x-commission-link']
      : '';
  app.get('/api/links', async (request) => ({ links: links.list(actor(request)) }));
  app.post<{ Body: RequestLinkInput }>(
    '/api/links',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['brief', 'amount', 'visibility', 'agreeToRules'],
          properties: {
            brief: { type: 'string', minLength: 1, maxLength: service.policy.maximumBriefLength },
            amount: {
              type: 'integer',
              minimum: service.policy.minimumAmount,
              maximum: service.policy.maximumAmount,
            },
            visibility: { enum: ['public', 'anonymous', 'hidden'] },
            agreeToRules: { const: true },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(links.create(actor(request), key(request), request.body)),
  );
  app.post<{ Params: { id: string } }>('/api/links/:id/reissue', async (request) =>
    links.reissue(actor(request), request.params.id, key(request)),
  );
  app.post<{ Params: { id: string } }>('/api/links/:id/withdraw', async (request) =>
    links.withdraw(actor(request), request.params.id, key(request)),
  );
  app.get('/api/link', async (request) => links.read(linkToken(request), optionalAccount(request)));
  app.post<{ Body: { agreeToRules: boolean } }>(
    '/api/link/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['agreeToRules'],
          additionalProperties: false,
          properties: { agreeToRules: { const: true } },
        },
      },
    },
    async (request) =>
      links.accept(
        identity(request).account,
        linkToken(request),
        key(request),
        request.body.agreeToRules,
      ),
  );
  app.post('/api/link/decline', async (request) => links.decline(linkToken(request), key(request)));
  const expirationTimer = setInterval(() => {
    try {
      links.expire();
      x?.cleanup();
    } catch {
      app.log.error('Expiration failed');
    }
  }, 1000);
  expirationTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(expirationTimer);
  });
  app.get('/api/session', async (request) => service.session(actor(request)));
  app.get('/api/requests', async (request) => ({ requests: service.list(actor(request)) }));
  app.get('/api/works', async () => ({ works: service.publicWorks() }));
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request) =>
    service.get(actor(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', async (request) =>
    service.cancel(actor(request), request.params.id, key(request)),
  );
  app.post<{ Params: { id: string }; Body: { files: UploadInput[] } }>(
    '/api/requests/:id/deliver',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['files'],
          properties: {
            files: {
              type: 'array',
              minItems: 1,
              maxItems: service.policy.maximumFiles,
              items: {
                type: 'object',
                required: ['name', 'content'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 180 },
                  content: { type: 'string', maxLength: 12 * 1024 * 1024 },
                },
              },
            },
          },
        },
      },
    },
    async (request) =>
      service.deliver(actor(request), request.params.id, key(request), request.body.files),
  );
  app.get<{ Params: { id: string } }>('/api/files/:id', async (request, reply) => {
    const file = service.download(actor(request), request.params.id);
    const encodedName = encodeURIComponent(file.name).replace(
      /['()*]/g,
      (s) => `%${s.charCodeAt(0).toString(16)}`,
    );
    return reply
      .header(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
      )
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .type('application/octet-stream')
      .send(Buffer.from(file.data));
  });
  const root = options.staticRoot ?? resolve('dist/client');
  if (existsSync(resolve(root, 'index.html'))) {
    await app.register(staticFiles, { root, index: ['index.html'], dotfiles: 'deny' });
  }
  return app;
}
