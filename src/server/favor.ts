import { resolve } from 'node:path';
import { createClerkClient } from '@clerk/backend';
import type { IdentitySession } from '../shared.js';
import { AuthService, type ResolvedIdentity } from './auth.js';
import { StripeConnect } from './connect-provider.js';
import {
  fileDelivery,
  resendDelivery,
  testDomainDelivery,
  type EmailDelivery,
} from './email-delivery.js';
import { DomainError } from './errors.js';
import { StripePayments } from './payment-provider.js';
import { parsePublicOrigin } from './public-origin.js';
import { publicProfile, type PublicProfile } from './public-profile.js';
import { RequestLinkService } from './request-links.js';
import { RequestService } from './service.js';
import { Store } from './store.js';

export interface ClerkKeys {
  publishableKey: string;
  secretKey: string;
}
export interface FavorConfig {
  service: RequestService;
  /** demo: local sign-in by address, loopback only. Otherwise Clerk owns sign-in. */
  auth: 'demo' | ClerkKeys;
  mail?: EmailDelivery;
  publicOrigin?: string;
  publicProfile?: PublicProfile;
  trustLoopbackProxy?: boolean;
  log?: (message: string) => void;
}
const PROFILE_TTL_MS = 300_000;
const isLoopback = (hostname: string) => ['localhost', '127.0.0.1'].includes(hostname);

/** Everything a request handler needs: the services, who is signed in, and the request rules. */
export class Favor {
  readonly service: RequestService;
  readonly auth: AuthService;
  readonly links: RequestLinkService;
  readonly mode: 'clerk' | 'demo';
  readonly clerk: ClerkKeys | null;
  readonly origin: URL | null;
  readonly publicProfile: PublicProfile | null;
  readonly sessionCookieName: string;
  readonly trustLoopbackProxy: boolean;
  readonly log: (message: string) => void;
  private readonly clerkClient;
  private readonly profiles = new Map<string, { at: number; identity: ResolvedIdentity }>();
  private reconciliation: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(config: FavorConfig) {
    this.service = config.service;
    this.origin = config.publicOrigin === undefined ? null : parsePublicOrigin(config.publicOrigin);
    this.mode = config.auth === 'demo' ? 'demo' : 'clerk';
    this.clerk = config.auth === 'demo' ? null : config.auth;
    this.publicProfile = config.publicProfile ? publicProfile(config.publicProfile) : null;
    if (
      this.service.payments.provider.mode === 'stripe_live' &&
      (!this.publicProfile ||
        this.origin?.protocol !== 'https:' ||
        !this.clerk?.publishableKey.startsWith('pk_live_') ||
        !this.clerk.secretKey.startsWith('sk_live_') ||
        this.service.recipients.provider.mode !== 'stripe_live')
    )
      throw new Error(
        'Live payments require HTTPS, live Clerk keys, and complete public business information.',
      );
    if (this.mode === 'demo' && this.origin && !isLoopback(this.origin.hostname))
      throw new Error('Demo authentication is allowed only on loopback.');
    if (config.trustLoopbackProxy && !this.origin)
      throw new Error('FAVOR_PUBLIC_ORIGIN is required when trusting the loopback proxy.');
    if (
      this.clerk &&
      (!this.clerk.secretKey.startsWith('sk_') || !this.clerk.publishableKey.startsWith('pk_'))
    )
      throw new Error('CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required.');
    this.trustLoopbackProxy = config.trustLoopbackProxy === true;
    this.log = config.log ?? (() => {});
    this.auth = new AuthService(this.service.store, this.service.clock, {
      allowDemo: this.mode === 'demo',
      provider: this.mode,
    });
    this.links = new RequestLinkService(this.service, this.auth, config.mail);
    // The browser rejects parent-domain cookies with a __Host- prefix.
    this.sessionCookieName =
      this.origin?.protocol === 'https:' ? '__Host-favor_session' : 'favor_session';
    this.clerkClient = this.clerk
      ? createClerkClient({
          secretKey: this.clerk.secretKey,
          publishableKey: this.clerk.publishableKey,
        })
      : null;
  }
  get secureCookies() {
    return this.origin?.protocol === 'https:';
  }
  /** The origin pages and mails point at: the configured one, else the request's own. */
  pageOrigin(request: Request): string {
    return this.origin?.origin ?? new URL(request.url).origin;
  }
  /** Whether a request arrived at the address this instance serves. */
  hostAllowed(request: Request): boolean {
    const url = new URL(request.url);
    const host = request.headers.get('host') ?? url.host;
    if (this.origin) return host === this.origin.host;
    return isLoopback(host.replace(/:\d+$/, ''));
  }
  /** Origins allowed to submit changes. */
  actionOrigins(request: Request): string[] {
    return [this.pageOrigin(request)];
  }
  /** Favor's user for a Clerk user id; the profile is fetched from Clerk and cached briefly. */
  async admitClerk(userId: string): Promise<IdentitySession> {
    if (!this.clerkClient) throw new DomainError('UNAUTHORIZED', 'ログインしてください。', 401);
    const cached = this.profiles.get(userId);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return this.auth.admit(cached.identity);
    const user = await this.clerkClient.users.getUser(userId);
    const primary = user.emailAddresses.find((item) => item.id === user.primaryEmailAddressId);
    const email = (primary ?? user.emailAddresses[0])?.emailAddress.trim().toLowerCase() ?? null;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
      user.username ||
      (email ? email.split('@')[0]! : `ユーザー ${userId.slice(-8)}`);
    const identity = { subject: userId, email, name };
    this.profiles.set(userId, { at: Date.now(), identity });
    return this.auth.admit(identity);
  }
  /** Expires links and requests and settles payments in the background. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.reconciliation) return;
      this.reconciliation = (async () => {
        this.links.expire();
        this.service.expire();
        await this.service.payments.reconcile();
        await this.service.transfers.reconcile();
      })()
        .catch(() => this.log('Expiration failed'))
        .finally(() => {
          this.reconciliation = null;
        });
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.reconciliation;
  }
  close() {
    this.service.store.close();
  }
}

/** Reads the process environment the way the server entrypoint expects it. */
export async function configFromEnv(env: Record<string, string | undefined>): Promise<FavorConfig> {
  const authMode = env.FAVOR_AUTH_MODE ?? 'clerk';
  if (!['clerk', 'demo'].includes(authMode))
    throw new Error('FAVOR_AUTH_MODE must be clerk or demo.');
  const publicOrigin = env.FAVOR_PUBLIC_ORIGIN;
  const profile = env.FAVOR_PUBLIC_PROFILE
    ? publicProfile(JSON.parse(env.FAVOR_PUBLIC_PROFILE))
    : undefined;
  const paymentMode = env.FAVOR_PAYMENT_MODE ?? 'mock';
  if (paymentMode !== 'mock' && paymentMode !== 'stripe_test' && paymentMode !== 'stripe_live')
    throw new Error('FAVOR_PAYMENT_MODE must be mock, stripe_test, or stripe_live.');
  const auth =
    authMode === 'demo'
      ? ('demo' as const)
      : {
          secretKey: env.CLERK_SECRET_KEY ?? '',
          publishableKey: env.CLERK_PUBLISHABLE_KEY ?? '',
        };
  if (
    paymentMode === 'stripe_live' &&
    (!env.FAVOR_DATA_DIR ||
      !publicOrigin ||
      parsePublicOrigin(publicOrigin).protocol !== 'https:' ||
      !profile ||
      auth === 'demo' ||
      !auth.publishableKey.startsWith('pk_live_') ||
      !auth.secretKey.startsWith('sk_live_') ||
      env.FAVOR_TEST_MAIL_DOMAIN)
  )
    throw new Error(
      'Live payments require a dedicated data directory, HTTPS, live Clerk keys, public business information, and real email delivery.',
    );
  const trustProxy = env.FAVOR_TRUST_PROXY ?? 'none';
  if (!['none', 'loopback'].includes(trustProxy))
    throw new Error('FAVOR_TRUST_PROXY must be none or loopback.');
  const directory = resolve(env.FAVOR_DATA_DIR ?? 'data');
  const production = env.NODE_ENV === 'production';
  const publicHost = publicOrigin && !isLoopback(parsePublicOrigin(publicOrigin).hostname);
  const delivery = env.FAVOR_MAIL_DELIVERY ?? (production ? 'resend' : 'file');
  if (!['file', 'resend'].includes(delivery))
    throw new Error('FAVOR_MAIL_DELIVERY must be file or resend.');
  if (delivery === 'file' && (production || publicHost))
    throw new Error(
      'File email delivery is allowed only for local development. Configure Resend for public access.',
    );
  const testMailDomain = (env.FAVOR_TEST_MAIL_DOMAIN ?? '').trim().toLowerCase();
  if (testMailDomain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test$/.test(testMailDomain))
    throw new Error('FAVOR_TEST_MAIL_DOMAIN must be a reserved .test domain.');
  const providerDelivery =
    delivery === 'resend'
      ? resendDelivery(env.RESEND_API_KEY ?? '', env.FAVOR_EMAIL_FROM ?? '')
      : fileDelivery(resolve(directory, 'mail'));
  const mail = testMailDomain
    ? testDomainDelivery(testMailDomain, fileDelivery(resolve(directory, 'mail')), providerDelivery)
    : providerDelivery;
  if (paymentMode === 'mock' && publicHost)
    throw new Error('Public deployments require Stripe payments.');
  if (paymentMode === 'stripe_live' && delivery !== 'resend')
    throw new Error('Live payments require real email delivery.');
  const payments =
    paymentMode !== 'mock'
      ? new StripePayments(
          env.STRIPE_API_KEY ?? '',
          env.STRIPE_WEBHOOK_SECRET ?? '',
          {},
          paymentMode,
        )
      : undefined;
  if (payments) await payments.verifyAccount(env.STRIPE_ACCOUNT_ID ?? '');
  const store = new Store(resolve(directory, 'app.sqlite'));
  try {
    store.bindInstance(
      paymentMode,
      payments ? env.STRIPE_ACCOUNT_ID! : '',
      auth === 'demo' ? 'demo' : auth.publishableKey,
    );
  } catch (error) {
    store.close();
    throw error;
  }
  const service = new RequestService(
    store,
    Date.now,
    {},
    payments,
    payments ? new StripeConnect(payments.stripe, payments.mode) : undefined,
  );
  return {
    service,
    auth,
    mail,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(profile ? { publicProfile: profile } : {}),
    trustLoopbackProxy: trustProxy === 'loopback',
    log: (message) => console.error(message),
  };
}
