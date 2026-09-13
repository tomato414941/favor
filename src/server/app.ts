import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { genres, type RequestInput, type UploadInput } from '../shared.js';
import { CommissionService, DomainError } from './service.js';
import type { FastifyError, FastifyRequest } from 'fastify';

export async function buildApp(service: CommissionService, options: { staticRoot?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 12 * 1024 * 1024 });
  await app.register(cookie, { secret: randomBytes(32).toString('hex') });
  app.addHook('onRequest', async (request, reply) => {
    if (!['localhost', '127.0.0.1'].includes(request.hostname)) return reply.code(403).send({ message: 'ローカル環境から利用してください。' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers['x-commission-action'] !== '1') return reply.code(403).send({ message: '操作を確認できませんでした。' });
      const origin = request.headers.origin;
      if (origin) {
        const allowed = [`http://${request.headers.host}`, 'http://localhost:5173', 'http://127.0.0.1:5173'];
        if (!allowed.includes(origin)) return reply.code(403).send({ message: 'この送信元からは操作できません。' });
      }
    }
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error.validation || (error.statusCode && error.statusCode < 500)) return reply.code(error.statusCode ?? 400).send({ message: '入力内容または送信形式を確認してください。' });
    app.log.error(error);
    return reply.code(500).send({ message: '処理を完了できませんでした。時間をおいてお試しください。' });
  });
  const actor = (request: FastifyRequest): string => {
    const raw = request.cookies.commission_session;
    const value = raw ? request.unsignCookie(raw) : null;
    if (!value?.valid || !value.value) throw new DomainError('UNAUTHORIZED', '体験する役割を選んでください。', 401);
    return value.value;
  };
  const key = (request: FastifyRequest): string => typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : '';
  app.get('/api/health', async () => ({ ok: true, mode: 'demo' }));
  app.get('/api/creator', async () => ({ creator: service.creator(), limits: { brief: service.policy.maximumBriefLength, files: service.policy.maximumFiles, uploadBytes: service.policy.maximumUploadBytes } }));
  app.post<{ Body: { role: 'client' | 'creator' } }>('/api/demo/session', {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: ['client', 'creator'] } } } },
  }, async (request, reply) => {
    const id = request.body.role === 'client' ? 'demo-client' : 'demo-creator';
    reply.setCookie('commission_session', id, { signed: true, httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 });
    return service.session(id);
  });
  app.get('/api/session', async (request) => service.session(actor(request)));
  app.get('/api/requests', async (request) => ({ requests: service.list(actor(request)) }));
  app.get('/api/works', async () => ({ works: service.publicWorks() }));
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request) => service.get(actor(request), request.params.id));
  app.post<{ Body: RequestInput }>('/api/requests', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['creatorId', 'genre', 'brief', 'amount', 'visibility', 'paymentMethod', 'nsfw', 'agreeToRules'],
      properties: {
        creatorId: { type: 'string', maxLength: 100 }, genre: { enum: Object.keys(genres) },
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
