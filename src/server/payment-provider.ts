import Stripe from 'stripe';
import { DomainError } from './errors.js';

export interface CardPayment {
  link_id: string;
  amount: number;
  checkout_id: string | null;
  intent_id: string | null;
  checkout_expires_at: number;
  hold_until: number;
  origin: string;
}
export interface CardStatus {
  state: 'pending' | 'authorized' | 'captured' | 'released';
  intentId: string | null;
  holdUntil: number;
}
export interface Checkout {
  id: string;
  url: string | null;
}
export interface PaymentEvent {
  id: string;
  linkId: string;
  checkoutId?: string;
}
export interface PaymentProvider {
  readonly mode: 'mock' | 'stripe_test';
  checkout(payment: CardPayment): Promise<Checkout>;
  inspect(payment: CardPayment): Promise<CardStatus>;
  capture(payment: CardPayment): Promise<CardStatus>;
  release(payment: CardPayment): Promise<CardStatus>;
  event?(body: Buffer, signature: string): PaymentEvent | null;
}

const mismatch = () => new DomainError('PAYMENT_MISMATCH', '支払いの状態を確認できません。', 502);

export class StripePayments implements PaymentProvider {
  readonly mode = 'stripe_test' as const;
  readonly stripe: Stripe;
  constructor(
    key: string,
    private readonly webhookSecret: string,
    options: Stripe.StripeConfig = {},
  ) {
    if (!/^rk_test_[A-Za-z0-9]+$/.test(key))
      throw new Error('Stripe payments require a restricted test key.');
    if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret))
      throw new Error('A Stripe webhook signing secret is required.');
    this.stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 1, ...options });
  }
  async verifyAccount(expected: string) {
    if (!/^acct_[A-Za-z0-9]+$/.test(expected)) throw new Error('STRIPE_ACCOUNT_ID is required.');
    const account = await this.stripe.accounts.retrieveCurrent();
    if (account.id !== expected)
      throw new Error('Stripe account does not match STRIPE_ACCOUNT_ID.');
  }
  async checkout(payment: CardPayment): Promise<Checkout> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        locale: 'ja',
        custom_text: { submit: { message: '納品時に支払いが確定します。' } },
        line_items: [
          {
            price_data: {
              currency: 'jpy',
              unit_amount: payment.amount,
              product_data: { name: 'Favor' },
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          capture_method: 'manual',
          metadata: { favor_link_id: payment.link_id },
        },
        metadata: { favor_link_id: payment.link_id },
        success_url: `${payment.origin}/me/links/${payment.link_id}?payment=return`,
        cancel_url: `${payment.origin}/me/links/${payment.link_id}`,
        expires_at: Math.floor(payment.checkout_expires_at / 1000),
      },
      { idempotencyKey: `favor:${payment.link_id}:checkout` },
    );
    this.checkSession(session, payment);
    return { id: session.id, url: session.url };
  }
  private checkSession(session: Stripe.Checkout.Session, payment: CardPayment) {
    if (
      session.livemode ||
      session.metadata?.favor_link_id !== payment.link_id ||
      session.amount_total !== payment.amount ||
      session.currency !== 'jpy' ||
      session.mode !== 'payment'
    )
      throw mismatch();
  }
  private status(intent: Stripe.PaymentIntent, payment: CardPayment): CardStatus {
    if (
      intent.livemode ||
      intent.metadata.favor_link_id !== payment.link_id ||
      intent.amount !== payment.amount ||
      intent.currency !== 'jpy' ||
      intent.capture_method !== 'manual' ||
      (payment.intent_id && intent.id !== payment.intent_id)
    )
      throw mismatch();
    if (intent.status === 'canceled')
      return { state: 'released', intentId: intent.id, holdUntil: 0 };
    if (intent.status === 'succeeded') {
      if (intent.amount_received !== payment.amount) throw mismatch();
      return { state: 'captured', intentId: intent.id, holdUntil: payment.hold_until };
    }
    if (intent.status !== 'requires_capture')
      return { state: 'pending', intentId: intent.id, holdUntil: 0 };
    const charge = intent.latest_charge;
    const before =
      typeof charge === 'object' && charge?.payment_method_details?.card?.capture_before;
    if (intent.amount_capturable !== payment.amount || !before) throw mismatch();
    return { state: 'authorized', intentId: intent.id, holdUntil: before * 1000 };
  }
  async inspect(payment: CardPayment): Promise<CardStatus> {
    if (!payment.checkout_id) throw mismatch();
    const session = await this.stripe.checkout.sessions.retrieve(payment.checkout_id, {
      expand: ['payment_intent.latest_charge'],
    });
    this.checkSession(session, payment);
    if (typeof session.payment_intent === 'object' && session.payment_intent)
      return this.status(session.payment_intent, payment);
    return {
      state: session.status === 'expired' ? 'released' : 'pending',
      intentId: null,
      holdUntil: 0,
    };
  }
  async capture(payment: CardPayment): Promise<CardStatus> {
    const current = await this.inspect(payment);
    if (current.state === 'captured' || current.state === 'released') return current;
    if (current.state !== 'authorized' || !current.intentId) throw mismatch();
    const intent = await this.stripe.paymentIntents.capture(
      current.intentId,
      { expand: ['latest_charge'] },
      { idempotencyKey: `favor:${payment.link_id}:capture` },
    );
    return this.status(intent, { ...payment, intent_id: current.intentId });
  }
  async release(payment: CardPayment): Promise<CardStatus> {
    if (!payment.checkout_id) throw mismatch();
    let session = await this.stripe.checkout.sessions.retrieve(payment.checkout_id);
    this.checkSession(session, payment);
    if (session.status === 'open') {
      try {
        session = await this.stripe.checkout.sessions.expire(
          session.id,
          {},
          { idempotencyKey: `favor:${payment.link_id}:expire` },
        );
      } catch (error) {
        // Completion can win the race with expiration. Re-read before deciding what to release.
        if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
        session = await this.stripe.checkout.sessions.retrieve(session.id);
        if (session.status === 'open') throw error;
      }
    }
    const current = await this.inspect(payment);
    if (current.state === 'released') return current;
    if (current.state !== 'authorized' || !current.intentId) throw mismatch();
    const intent = await this.stripe.paymentIntents.cancel(
      current.intentId,
      { expand: ['latest_charge'] },
      { idempotencyKey: `favor:${payment.link_id}:release` },
    );
    return this.status(intent, { ...payment, intent_id: current.intentId });
  }
  event(body: Buffer, signature: string): PaymentEvent | null {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(body, signature, this.webhookSecret);
    } catch {
      throw new DomainError('INVALID_SIGNATURE', '決済通知を確認できません。', 400);
    }
    if (event.livemode || event.account)
      throw new DomainError('INVALID_EVENT', '決済通知を確認できません。', 400);
    const object = event.data.object;
    if (
      object.object === 'checkout.session' &&
      ['checkout.session.completed', 'checkout.session.expired'].includes(event.type)
    ) {
      const linkId = object.metadata?.favor_link_id;
      return linkId ? { id: event.id, linkId, checkoutId: object.id } : null;
    }
    if (
      object.object === 'payment_intent' &&
      [
        'payment_intent.amount_capturable_updated',
        'payment_intent.succeeded',
        'payment_intent.canceled',
        'payment_intent.payment_failed',
      ].includes(event.type)
    ) {
      const linkId = object.metadata.favor_link_id;
      return linkId ? { id: event.id, linkId } : null;
    }
    return null;
  }
}

/** Deterministic local substitute. Public deployments use Stripe's sandbox. */
export class MockPayments implements PaymentProvider {
  readonly mode = 'mock' as const;
  constructor(
    private readonly clock = Date.now,
    readonly options: { failAuthorization?: boolean; failCapture?: boolean; holdMs?: number } = {},
  ) {}
  async checkout(payment: CardPayment): Promise<Checkout> {
    if (this.options.failAuthorization)
      throw new DomainError('PAYMENT_DECLINED', '仮押さえできませんでした。', 422);
    return { id: `mock_${payment.link_id}`, url: null };
  }
  async inspect(payment: CardPayment): Promise<CardStatus> {
    return {
      state: 'authorized',
      intentId: `mock_${payment.link_id}`,
      holdUntil: payment.hold_until || this.clock() + (this.options.holdMs ?? 30 * 86400000),
    };
  }
  async capture(payment: CardPayment): Promise<CardStatus> {
    if (this.options.failCapture)
      throw new DomainError('PAYMENT_DECLINED', '支払いを確定できませんでした。', 422);
    return { state: 'captured', intentId: payment.intent_id, holdUntil: payment.hold_until };
  }
  async release(payment: CardPayment): Promise<CardStatus> {
    return { state: 'released', intentId: payment.intent_id, holdUntil: 0 };
  }
}
