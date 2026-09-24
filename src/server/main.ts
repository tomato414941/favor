import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { RequestService } from './service.js';
import { Store } from './store.js';
import { StripePayments } from './payment-provider.js';
import { clerkResolver } from './identity.js';
import { fileDelivery, resendDelivery, testDomainDelivery } from './email-delivery.js';
import { parsePublicOrigin } from './public-origin.js';

const port = Number(process.env.FAVOR_PORT ?? 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('FAVOR_PORT must be an integer from 1024 to 65535.');
const authMode = process.env.FAVOR_AUTH_MODE ?? 'clerk';
if (!['clerk', 'demo'].includes(authMode))
  throw new Error('FAVOR_AUTH_MODE must be clerk or demo.');
const publicOrigin = process.env.FAVOR_PUBLIC_ORIGIN;
const trustProxy = process.env.FAVOR_TRUST_PROXY ?? 'none';
if (!['none', 'loopback'].includes(trustProxy))
  throw new Error('FAVOR_TRUST_PROXY must be none or loopback.');
const directory = resolve(process.env.FAVOR_DATA_DIR ?? 'data');
const delivery =
  process.env.FAVOR_MAIL_DELIVERY ?? (process.env.NODE_ENV === 'production' ? 'resend' : 'file');
if (!['file', 'resend'].includes(delivery))
  throw new Error('FAVOR_MAIL_DELIVERY must be file or resend.');
if (
  delivery === 'file' &&
  (process.env.NODE_ENV === 'production' ||
    (publicOrigin &&
      !['localhost', '127.0.0.1'].includes(parsePublicOrigin(publicOrigin).hostname)))
)
  throw new Error(
    'File email delivery is allowed only for local development. Configure Resend for public access.',
  );
const testMailDomain = (process.env.FAVOR_TEST_MAIL_DOMAIN ?? '').trim().toLowerCase();
if (testMailDomain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test$/.test(testMailDomain))
  throw new Error('FAVOR_TEST_MAIL_DOMAIN must be a reserved .test domain.');
const providerDelivery =
  delivery === 'resend'
    ? resendDelivery(process.env.RESEND_API_KEY ?? '', process.env.FAVOR_EMAIL_FROM ?? '')
    : fileDelivery(resolve(directory, 'mail'));
const emailDelivery = testMailDomain
  ? testDomainDelivery(testMailDomain, fileDelivery(resolve(directory, 'mail')), providerDelivery)
  : providerDelivery;
const store = new Store(resolve(directory, 'app.sqlite'));
const paymentMode = process.env.FAVOR_PAYMENT_MODE ?? 'mock';
if (!['mock', 'stripe_test'].includes(paymentMode))
  throw new Error('FAVOR_PAYMENT_MODE must be mock or stripe_test.');
if (
  paymentMode === 'mock' &&
  publicOrigin &&
  !['localhost', '127.0.0.1'].includes(parsePublicOrigin(publicOrigin).hostname)
)
  throw new Error('Public deployments require Stripe test payments.');
const payments =
  paymentMode === 'stripe_test'
    ? new StripePayments(process.env.STRIPE_API_KEY ?? '', process.env.STRIPE_WEBHOOK_SECRET ?? '')
    : undefined;
if (payments) await payments.verifyAccount(process.env.STRIPE_ACCOUNT_ID ?? '');
const service = new RequestService(store, Date.now, {}, payments);
const identity =
  authMode === 'clerk'
    ? {
        resolver: clerkResolver({
          secretKey: process.env.CLERK_SECRET_KEY ?? '',
          publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
          // Server-minted session tokens (ops scripts) carry no azp claim, so the
          // authorized-party check stays off while Favor is this instance's only frontend.
        }),
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
      }
    : undefined;
const app = await buildApp(service, {
  logger: true,
  demoAuth: authMode === 'demo',
  ...(identity ? { identity } : {}),
  emailDelivery,
  publicOrigin,
  trustLoopbackProxy: trustProxy === 'loopback',
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
try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  await close();
  throw error;
}
