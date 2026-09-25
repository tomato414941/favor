import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RequestLinkInput, UploadInput } from '../shared.js';
import { RequestService, DomainError } from './service.js';
import { AuthService } from './auth.js';
import { RequestLinkService } from './request-links.js';
import type { EmailDelivery } from './email-delivery.js';
import type { IdentityResolver } from './identity.js';
import { parsePublicOrigin } from './public-origin.js';
import type { FastifyError, FastifyRequest } from 'fastify';

interface AppOptions {
  staticRoot?: string;
  logger?: boolean;
  /** Local sign-in by address only, without an identity provider. Loopback only. */
  demoAuth?: boolean;
  /** Identity provider (Clerk) and the key the browser needs to show its sign-in. */
  identity?: { resolver: IdentityResolver; publishableKey: string };
  emailDelivery?: EmailDelivery;
  publicOrigin?: string;
  trustLoopbackProxy?: boolean;
}

export async function buildApp(service: RequestService, options: AppOptions = {}) {
  if (options.demoAuth && options.identity)
    throw new Error('Demo sign-in and an identity provider cannot be enabled together.');
  if (!options.demoAuth && !options.identity)
    throw new Error('Either demo sign-in or an identity provider is required.');
  const origin =
    options.publicOrigin === undefined ? undefined : parsePublicOrigin(options.publicOrigin);
  const publicOrigin = origin?.origin;
  if (options.demoAuth && origin && !['localhost', '127.0.0.1'].includes(origin.hostname))
    throw new Error('Demo authentication is allowed only on loopback.');
  if (options.trustLoopbackProxy && !origin)
    throw new Error('FAVOR_PUBLIC_ORIGIN is required when trusting the loopback proxy.');
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
    ...(options.identity ? { resolver: options.identity.resolver } : {}),
  });
  const secureCookies = origin?.protocol === 'https:';
  // The browser rejects parent-domain cookies with a __Host- prefix.
  const sessionCookieName = secureCookies ? '__Host-favor_session' : 'favor_session';
  const sessionCookie = {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 86400,
    secure: secureCookies,
  };
  const links = new RequestLinkService(service, auth, options.emailDelivery);
  const pageOrigin = (request: FastifyRequest) => publicOrigin ?? `http://${request.headers.host}`;
  const identity = (request: FastifyRequest) =>
    auth.resolve(request, request.cookies[sessionCookieName]);
  const actor = async (request: FastifyRequest): Promise<string> =>
    (await identity(request)).account.subject;
  const optionalIdentity = async (request: FastifyRequest) => {
    try {
      return await identity(request);
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 401) return undefined;
      throw error;
    }
  };
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    if (
      (origin && origin.host !== request.headers.host) ||
      (!origin && !['localhost', '127.0.0.1'].includes(request.hostname))
    )
      return reply.code(403).send({ message: 'アクセス先のURLを確認してください。' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.routeOptions.url !== '/api/payments/stripe-webhook'
    ) {
      if (request.headers['x-favor-action'] !== '1')
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
  const key = (request: FastifyRequest): string =>
    typeof request.headers['idempotency-key'] === 'string'
      ? request.headers['idempotency-key']
      : '';
  app.get('/api/health', async () => ({ ok: true, demoAuth: options.demoAuth === true }));
  app.get('/api/auth/options', async () => ({
    mode: options.identity ? 'clerk' : 'demo',
    ...(options.identity ? { publishableKey: options.identity.publishableKey } : {}),
  }));
  app.get('/api/request-settings', async () => ({
    paymentMode: service.payments.provider.mode,
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
    app.post<{ Body: { email: string; name?: string } }>(
      '/api/demo/login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            additionalProperties: false,
            properties: {
              email: { type: 'string', minLength: 1, maxLength: 254 },
              name: { type: 'string', maxLength: 100 },
            },
          },
        },
      },
      async (request, reply) => {
        auth.logout(request.cookies[sessionCookieName]);
        const token = auth.demoLoginEmail(request.body.email, request.body.name);
        reply.setCookie(sessionCookieName, token, sessionCookie);
        return auth.identity(token);
      },
    );
  }
  app.get('/api/auth/identity', async (request) => {
    try {
      return await identity(request);
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 401) return null;
      throw error;
    }
  });
  // The identity provider ends its own session in the browser; this clears the demo cookie.
  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies[sessionCookieName]);
    reply.clearCookie(sessionCookieName, sessionCookie);
    return { ok: true };
  });
  const linkToken = (request: FastifyRequest): string =>
    typeof request.headers['x-favor-link'] === 'string' ? request.headers['x-favor-link'] : '';
  app.get('/api/links', async (request) => ({ links: links.list(await actor(request)) }));
  app.post<{ Body: RequestLinkInput }>(
    '/api/links',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['brief', 'amount', 'visibility', 'agreeToRules'],
          properties: {
            delivery: { enum: ['self', 'email'] },
            recipientEmail: { type: 'string', maxLength: 254 },
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
    async (request, reply) => {
      const user = await actor(request);
      const created = await links.create(user, key(request), request.body, pageOrigin(request));
      if (created.link.state === 'awaiting_payment' || created.link.delivery !== 'email')
        return reply.code(201).send(created);
      if (created.token)
        await links.send(user, created.link.id, created.token, pageOrigin(request), true);
      return reply.code(201).send({ link: links.get(user, created.link.id) });
    },
  );
  app.post<{ Params: { id: string } }>('/api/links/:id/checkout', async (request) =>
    links.checkout(await actor(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/links/:id/complete-payment', async (request) => {
    const user = await actor(request);
    const result = await links.complete(user, request.params.id, key(request));
    if (result.link.delivery !== 'email') return result;
    if (result.token)
      await links.send(user, result.link.id, result.token, pageOrigin(request), true);
    return { link: links.get(user, result.link.id) };
  });
  if (service.payments.provider.event) {
    await app.register(async (webhooks) => {
      webhooks.removeContentTypeParser('application/json');
      webhooks.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
      webhooks.post<{ Body: Buffer }>(
        '/api/payments/stripe-webhook',
        { bodyLimit: 256 * 1024 },
        async (request) => {
          const signature = request.headers['stripe-signature'];
          await service.payments.webhook(
            request.body,
            typeof signature === 'string' ? signature : '',
          );
          return { received: true };
        },
      );
    });
  }
  app.post<{ Params: { id: string } }>('/api/links/:id/reissue', async (request) => {
    const user = await actor(request);
    const result = links.reissue(user, request.params.id, key(request));
    if (result.link.delivery !== 'email') return result;
    if (result.token)
      await links.send(user, result.link.id, result.token, pageOrigin(request), false);
    return { link: links.get(user, result.link.id) };
  });
  app.post<{ Params: { id: string } }>('/api/links/:id/withdraw', async (request) =>
    links.withdraw(await actor(request), request.params.id, key(request)),
  );
  app.get('/api/links/by-token', async (request) => {
    const who = await optionalIdentity(request);
    return links.read(linkToken(request), who?.account, who?.email);
  });
  app.get('/api/links/optout', async (request) => {
    const who = await identity(request);
    if (!who.email) throw new DomainError('EMAIL_REQUIRED', 'メールでログインしてください。', 403);
    return links.optout(who.email);
  });
  app.post<{ Body: { blocked: boolean } }>(
    '/api/links/optout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blocked'],
          additionalProperties: false,
          properties: { blocked: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const who = await identity(request);
      if (!who.email)
        throw new DomainError('EMAIL_REQUIRED', 'メールでログインしてください。', 403);
      return links.setOptout(who.email, request.body.blocked);
    },
  );
  app.post<{ Body: { agreeToRules: boolean } }>(
    '/api/links/by-token/accept',
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
    async (request) => {
      const who = await identity(request);
      return links.accept(
        who.account,
        linkToken(request),
        key(request),
        request.body.agreeToRules,
        who.email,
      );
    },
  );
  app.post('/api/links/by-token/decline', async (request) => {
    const who = await optionalIdentity(request);
    return links.decline(linkToken(request), key(request), who?.account, who?.email);
  });
  let reconciliation: Promise<void> | null = null;
  const expirationTimer = setInterval(() => {
    if (reconciliation) return;
    reconciliation = (async () => {
      links.expire();
      service.expire();
      await service.payments.reconcile();
      await service.recipients.reconcile();
    })()
      .catch(() => {
        app.log.error('Expiration failed');
      })
      .finally(() => {
        reconciliation = null;
      });
  }, 1000);
  expirationTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(expirationTimer);
    await reconciliation;
  });
  app.get('/api/session', async (request) => service.session(await actor(request)));
  app.get('/api/recipient', async (request) => service.recipients.status(await actor(request)));
  app.post('/api/recipient/onboard', async (request) =>
    service.recipients.onboard(await actor(request), pageOrigin(request)),
  );
  app.post('/api/recipient/dashboard', async (request) =>
    service.recipients.dashboard(await actor(request)),
  );
  app.get('/api/requests', async (request) => ({ requests: service.list(await actor(request)) }));
  app.get('/api/works', async () => ({ works: service.publicWorks() }));
  app.get<{ Params: { id: string } }>('/api/works/:id', async (request) =>
    service.publicWork(request.params.id),
  );
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/works/:id/files/:fileId',
    async (request, reply) => {
      const file = service.publicImage(request.params.id, request.params.fileId);
      return reply
        .header('Content-Disposition', 'inline')
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Cache-Control', 'private, max-age=300')
        .type(file.type)
        .send(Buffer.from(file.data));
    },
  );
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request) =>
    service.get(await actor(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', async (request) =>
    service.cancel(await actor(request), request.params.id, key(request)),
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
      service.deliver(await actor(request), request.params.id, key(request), request.body.files),
  );
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/requests/:id/files/:fileId',
    async (request, reply) => {
      const file = service.download(await actor(request), request.params.id, request.params.fileId);
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
    },
  );
  const root = options.staticRoot ?? resolve('dist/client');
  if (existsSync(resolve(root, 'index.html'))) {
    await app.register(staticFiles, { root, index: ['index.html'], dotfiles: 'deny' });
    // Application pages live at their own paths; the browser decides what to show.
    app.setNotFoundHandler(async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) || request.url.startsWith('/api/'))
        return reply.code(404).send({ message: 'ページが見つかりません。' });
      return reply.header('Cache-Control', 'no-store').sendFile('index.html');
    });
  }
  return app;
}
