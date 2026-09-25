import type Stripe from 'stripe';
import { DomainError } from './errors.js';
import type { RecipientState } from '../shared.js';

export interface Recipient {
  id: string;
  account_id: string | null;
}
export interface Transfer {
  request_id: string;
  link_id: string;
  account_id: string;
  recipient_id: string;
  amount: number;
  payment_amount: number;
  intent_id: string;
}
export interface ConnectProvider {
  readonly mode: 'mock' | 'stripe_test';
  create(recipient: Recipient, email: string): Promise<string>;
  inspect(recipient: Recipient): Promise<RecipientState>;
  onboarding(recipient: Recipient, origin: string): Promise<string | null>;
  dashboard(recipient: Recipient): Promise<string | null>;
  transfer(transfer: Transfer): Promise<string>;
}
const mismatch = () => new DomainError('CONNECT_MISMATCH', '受取先を確認できません。', 502);

export class StripeConnect implements ConnectProvider {
  readonly mode = 'stripe_test' as const;
  constructor(private readonly stripe: Stripe) {}
  private check(account: Stripe.V2.Core.Account, recipient: Recipient) {
    if (
      account.livemode ||
      account.identity?.country !== 'JP' ||
      account.dashboard !== 'express' ||
      account.defaults?.responsibilities?.requirements_collector !== 'stripe' ||
      account.defaults.responsibilities.fees_collector !== 'application' ||
      account.defaults.responsibilities.losses_collector !== 'application' ||
      account.metadata?.favor_recipient_id !== recipient.id ||
      (recipient.account_id && account.id !== recipient.account_id)
    )
      throw mismatch();
  }
  private async checkPayouts(accountId: string) {
    const settings = await this.stripe.balanceSettings.retrieve({}, { stripeAccount: accountId });
    const payouts = settings.payments.payouts;
    const schedule = payouts?.schedule;
    // The JP account defaults are managed in Stripe; restricted keys can only read payout settings.
    if (
      schedule?.interval !== 'weekly' ||
      schedule.weekly_payout_days?.length !== 1 ||
      schedule.weekly_payout_days[0] !== 'friday' ||
      (payouts?.minimum_balance_by_currency?.jpy ?? 0) !== 0
    )
      throw new DomainError('PAYOUT_SETTINGS', '振込設定を確認できません。', 503);
    return payouts?.status === 'enabled';
  }
  async create(recipient: Recipient, email: string) {
    // Recover creation after a lost response, including beyond Stripe's idempotency window.
    for await (const account of this.stripe.v2.core.accounts.list({
      limit: 20,
      applied_configurations: ['recipient'],
    })) {
      if (account.metadata?.favor_recipient_id === recipient.id) {
        this.check(
          await this.stripe.v2.core.accounts.retrieve(account.id, {
            include: ['identity', 'defaults'],
          }),
          recipient,
        );
        await this.checkPayouts(account.id);
        return account.id;
      }
    }
    const account = await this.stripe.v2.core.accounts.create(
      {
        identity: { country: 'jp' },
        dashboard: 'express',
        contact_email: email,
        defaults: {
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        configuration: {
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        metadata: { favor_recipient_id: recipient.id },
        include: ['identity', 'defaults'],
      },
      { idempotencyKey: `favor:recipient:${recipient.id}` },
    );
    this.check(account, recipient);
    await this.checkPayouts(account.id);
    return account.id;
  }
  async inspect(recipient: Recipient): Promise<RecipientState> {
    if (!recipient.account_id) return 'unregistered';
    const account = await this.stripe.v2.core.accounts.retrieve(recipient.account_id, {
      include: ['identity', 'defaults', 'configuration.recipient', 'requirements'],
    });
    this.check(account, recipient);
    const payoutsEnabled = await this.checkPayouts(account.id);
    const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
    const due =
      account.requirements?.entries?.filter(
        (entry) => entry.minimum_deadline.status !== 'eventually_due',
      ) ?? [];
    if (
      balance?.stripe_transfers?.status === 'active' &&
      balance.payouts?.status === 'active' &&
      payoutsEnabled &&
      !due.length
    )
      return 'ready';
    if (due.length && due.every((entry) => entry.awaiting_action_from === 'stripe'))
      return 'reviewing';
    return 'incomplete';
  }
  async onboarding(recipient: Recipient, origin: string) {
    if (!recipient.account_id) throw mismatch();
    const link = await this.stripe.v2.core.accountLinks.create({
      account: recipient.account_id,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['recipient'],
          refresh_url: `${origin}/me/settings?onboarding=refresh`,
          return_url: `${origin}/me/settings?onboarding=return`,
          collection_options: { fields: 'eventually_due' },
        },
      },
    });
    if (link.livemode || link.account !== recipient.account_id) throw mismatch();
    return link.url;
  }
  async dashboard(recipient: Recipient) {
    if (!recipient.account_id) throw mismatch();
    return (await this.stripe.accounts.createLoginLink(recipient.account_id)).url;
  }
  async transfer(transfer: Transfer) {
    if (
      !Number.isSafeInteger(transfer.amount) ||
      !Number.isSafeInteger(transfer.payment_amount) ||
      transfer.amount <= 0 ||
      transfer.amount > transfer.payment_amount
    )
      throw mismatch();
    const group = `favor:${transfer.link_id}`;
    const check = (item: Stripe.Transfer) => {
      if (
        item.livemode ||
        item.amount !== transfer.amount ||
        item.currency !== 'jpy' ||
        item.destination !== transfer.account_id ||
        item.metadata.favor_request_id !== transfer.request_id ||
        item.reversed ||
        item.amount_reversed !== 0
      )
        throw mismatch();
      return item.id;
    };
    // Reconcile before creating, even after Stripe's idempotency cache expires.
    const previous = await this.stripe.transfers.list({ transfer_group: group, limit: 2 });
    if (previous.data.length > 1 || previous.has_more) throw mismatch();
    if (previous.data[0]) return check(previous.data[0]);
    if (
      (await this.inspect({ id: transfer.recipient_id, account_id: transfer.account_id })) !==
      'ready'
    )
      throw new DomainError('RECIPIENT_REQUIRED', '受取先の登録内容を確認してください。');
    const intent = await this.stripe.paymentIntents.retrieve(transfer.intent_id, {
      expand: ['latest_charge'],
    });
    const charge = intent.latest_charge;
    if (
      intent.livemode ||
      intent.status !== 'succeeded' ||
      intent.currency !== 'jpy' ||
      intent.amount_received !== transfer.payment_amount ||
      intent.metadata.favor_link_id !== transfer.link_id ||
      !charge ||
      typeof charge === 'string' ||
      !charge.captured ||
      charge.amount_refunded !== 0
    )
      throw mismatch();
    const result = await this.stripe.transfers.create(
      {
        amount: transfer.amount,
        currency: 'jpy',
        destination: transfer.account_id,
        source_transaction: charge.id,
        transfer_group: group,
        metadata: { favor_request_id: transfer.request_id },
      },
      { idempotencyKey: `favor:${transfer.request_id}:transfer` },
    );
    return check(result);
  }
}

export class MockConnect implements ConnectProvider {
  readonly mode = 'mock' as const;
  async create(recipient: Recipient) {
    return `acct_mock_${recipient.id}`;
  }
  async inspect(recipient: Recipient): Promise<RecipientState> {
    return recipient.account_id ? 'ready' : 'unregistered';
  }
  /** Stands in for Stripe's hosted onboarding: the person comes straight back as registered. */
  async onboarding(_recipient: Recipient, origin: string) {
    return `${origin}/me/settings?onboarding=return`;
  }
  async dashboard(_recipient: Recipient) {
    return null;
  }
  async transfer(transfer: Transfer) {
    return `tr_mock_${transfer.request_id}`;
  }
}
