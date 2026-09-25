import { index, prefix, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('works', 'routes/works.tsx'),
  route('works/:id', 'routes/work.tsx'),
  route('works/:id/files/:fileId', 'routes/work-image.tsx'),
  route('link', 'routes/link.tsx'),
  route('me', 'routes/me.tsx', [
    index('routes/me-index.tsx'),
    route('new', 'routes/me-new.tsx'),
    route('sent', 'routes/me-sent.tsx'),
    route('received', 'routes/me-received.tsx'),
    route('works', 'routes/me-works.tsx'),
    route('settings', 'routes/me-settings.tsx'),
    route('account', 'routes/me-account.tsx'),
    route('requests/:id', 'routes/me-request.tsx'),
    route('links/:id', 'routes/me-link.tsx'),
  ]),
  route('me/requests/:id/files/:fileId', 'routes/me-request-file.tsx'),
  ...prefix('api', [
    route('health', 'routes/api-health.tsx'),
    route('auth/identity', 'routes/api-identity.tsx'),
    route('links', 'routes/api-links.tsx'),
    route('links/by-token', 'routes/api-link-by-token.tsx'),
    route('links/:id/:intent', 'routes/api-link-intent.tsx'),
    route('requests', 'routes/api-requests.tsx'),
    route('requests/:id', 'routes/api-request.tsx'),
    route('payments/stripe-webhook', 'routes/api-stripe-webhook.tsx'),
  ]),
  route('*', 'routes/missing.tsx'),
] satisfies RouteConfig;
