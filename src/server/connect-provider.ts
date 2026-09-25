import Stripe from 'stripe';
import { DomainError } from './errors.js';
import type { PaymentMode, RecipientState } from '../shared.js';

export interface Recipient {
  id: string;
  account_id: string | null;
}
export interface TransferScope {
  request_id: string;
  link_id: string;
  account_id: string;
}
export interface Transfer extends TransferScope {
  operation_id: string;
  recipient_id: string;
  amount: number;
  payment_amount: number;
  intent_id: string;
}
export interface TransferSnapshot {
  id: string;
  amount: number;
  reversedAmount: number;
  operationId: string | null;
}
export interface Reversal extends TransferScope {
  operation_id: string;
  transfer_id: string;
  amount: number;
}
export interface TransferOperation {
  id: string;
  kind: 'transfer' | 'reversal';
  amount: number;
  source_id: string | null;
}
export interface ConnectProvider {
  readonly mode: PaymentMode;
  create(recipient: Recipient, email: string): Promise<string>;
  inspect(recipient: Recipient): Promise<RecipientState>;
  onboarding(recipient: Recipient, origin: string): Promise<string | null>;
  dashboard(recipient: Recipient): Promise<string | null>;
  transfer(transfer: Transfer): Promise<string>;
  transfers(scope: TransferScope): Promise<TransferSnapshot[]>;
  reverse(reversal: Reversal): Promise<string>;
  findOperation(scope: TransferScope, operation: TransferOperation): Promise<string | null>;
}
const mismatch = () => new DomainError('CONNECT_MISMATCH', '受取先を確認できません。', 502);

/** Stripe explicitly declined the command before moving money; a later attempt can use a new key. */
export class TransferRejected extends Error {
  readonly code = 'balance_insufficient';
  constructor() {
    super('Stripe declined the transfer because the available balance was insufficient.');
  }
}
function transferError(error: unknown): never {
  if (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.code === 'balance_insufficient'
  )
    throw new TransferRejected();
  throw error;
}

export class StripeConnect implements ConnectProvider {
  constructor(
    private readonly stripe: Stripe,
    readonly mode: 'stripe_test' | 'stripe_live' = 'stripe_test',
  ) {}
  private get live() {
    return this.mode === 'stripe_live';
  }
  private check(account: Stripe.V2.Core.Account, recipient: Recipient) {
    if (
      account.livemode !== this.live ||
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
    if (link.livemode !== this.live || link.account !== recipient.account_id) throw mismatch();
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
        item.livemode !== this.live ||
        item.amount !== transfer.amount ||
        item.currency !== 'jpy' ||
        item.destination !== transfer.account_id ||
        item.metadata.favor_request_id !== transfer.request_id ||
        item.metadata.favor_operation_id !== transfer.operation_id
      )
        throw mismatch();
      return item.id;
    };
    // Reconcile before creating, even after Stripe's idempotency cache expires.
    const previous = await this.transfers(transfer);
    const existing = previous.filter((item) => item.operationId === transfer.operation_id);
    if (existing.length > 1) throw mismatch();
    if (existing[0]) {
      if (existing[0].amount !== transfer.amount) throw mismatch();
      return existing[0].id;
    }
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
      intent.livemode !== this.live ||
      intent.status !== 'succeeded' ||
      intent.currency !== 'jpy' ||
      intent.amount_received !== transfer.payment_amount ||
      intent.metadata.favor_link_id !== transfer.link_id ||
      !charge ||
      typeof charge === 'string' ||
      !charge.captured
    )
      throw mismatch();
    const result = await this.stripe.transfers
      .create(
        {
          amount: transfer.amount,
          currency: 'jpy',
          destination: transfer.account_id,
          ...(previous.length === 0 ? { source_transaction: charge.id } : {}),
          transfer_group: group,
          metadata: {
            favor_request_id: transfer.request_id,
            favor_operation_id: transfer.operation_id,
          },
        },
        { idempotencyKey: `favor:transfer:${transfer.operation_id}` },
      )
      .catch(transferError);
    return check(result);
  }
  async transfers(scope: TransferScope): Promise<TransferSnapshot[]> {
    const result: TransferSnapshot[] = [];
    for await (const item of this.stripe.transfers.list({
      transfer_group: `favor:${scope.link_id}`,
      limit: 100,
    })) {
      if (
        item.livemode !== this.live ||
        item.currency !== 'jpy' ||
        item.destination !== scope.account_id ||
        item.metadata.favor_request_id !== scope.request_id ||
        !Number.isSafeInteger(item.amount) ||
        item.amount <= 0 ||
        !Number.isSafeInteger(item.amount_reversed) ||
        item.amount_reversed < 0 ||
        item.amount_reversed > item.amount
      )
        throw mismatch();
      result.push({
        id: item.id,
        amount: item.amount,
        reversedAmount: item.amount_reversed,
        operationId: item.metadata.favor_operation_id ?? null,
      });
    }
    return result;
  }
  async reverse(reversal: Reversal): Promise<string> {
    const item = (await this.transfers(reversal)).find((item) => item.id === reversal.transfer_id);
    if (!item || !Number.isSafeInteger(reversal.amount) || reversal.amount <= 0) throw mismatch();
    for await (const existing of this.stripe.transfers.listReversals(item.id, { limit: 100 })) {
      if (existing.metadata?.favor_operation_id === reversal.operation_id) {
        if (existing.amount !== reversal.amount) throw mismatch();
        return existing.id;
      }
    }
    if (reversal.amount > item.amount - item.reversedAmount) throw mismatch();
    const result = await this.stripe.transfers
      .createReversal(
        item.id,
        {
          amount: reversal.amount,
          metadata: {
            favor_request_id: reversal.request_id,
            favor_operation_id: reversal.operation_id,
          },
        },
        { idempotencyKey: `favor:reversal:${reversal.operation_id}` },
      )
      .catch(transferError);
    if (result.amount !== reversal.amount || result.transfer !== item.id) throw mismatch();
    return result.id;
  }
  async findOperation(scope: TransferScope, operation: TransferOperation) {
    const transfers = await this.transfers(scope);
    if (operation.kind === 'transfer') {
      const matches = transfers.filter((item) => item.operationId === operation.id);
      if (matches.length > 1 || (matches[0] && matches[0].amount !== operation.amount))
        throw mismatch();
      return matches[0]?.id ?? null;
    }
    if (!operation.source_id || !transfers.some((item) => item.id === operation.source_id))
      throw mismatch();
    for await (const item of this.stripe.transfers.listReversals(operation.source_id, {
      limit: 100,
    })) {
      if (item.metadata?.favor_operation_id === operation.id) {
        if (item.amount !== operation.amount) throw mismatch();
        return item.id;
      }
    }
    return null;
  }
}

export class MockConnect implements ConnectProvider {
  readonly mode = 'mock' as const;
  private readonly ledger = new Map<string, { scope: TransferScope; item: TransferSnapshot }>();
  private readonly reversed = new Map<string, string>();
  async create(recipient: Recipient, _email: string) {
    return `acct_mock_${recipient.id}`;
  }
  async inspect(recipient: Recipient): Promise<RecipientState> {
    return recipient.account_id ? 'ready' : 'unregistered';
  }
  /** Stands in for Stripe's hosted onboarding: the person comes straight back as registered. */
  async onboarding(_recipient: Recipient, origin: string) {
    return `${origin}/me/settings?onboarding=return`;
  }
  async dashboard(_recipient: Recipient): Promise<string | null> {
    return null;
  }
  async transfer(transfer: Transfer) {
    const id = `tr_${transfer.operation_id}`;
    if (!this.ledger.has(id))
      this.ledger.set(id, {
        scope: transfer,
        item: {
          id,
          amount: transfer.amount,
          reversedAmount: 0,
          operationId: transfer.operation_id,
        },
      });
    return id;
  }
  async transfers(scope: TransferScope) {
    return [...this.ledger.values()]
      .filter((row) => row.scope.request_id === scope.request_id)
      .map((row) => ({ ...row.item }));
  }
  async reverse(reversal: Reversal) {
    const previous = this.reversed.get(reversal.operation_id);
    if (previous) return previous;
    const row = this.ledger.get(reversal.transfer_id);
    if (!row || reversal.amount > row.item.amount - row.item.reversedAmount) throw mismatch();
    row.item.reversedAmount += reversal.amount;
    const id = `trr_${reversal.operation_id}`;
    this.reversed.set(reversal.operation_id, id);
    return id;
  }
  async findOperation(scope: TransferScope, operation: TransferOperation) {
    if (operation.kind === 'reversal') return this.reversed.get(operation.id) ?? null;
    return (
      (await this.transfers(scope)).find((item) => item.operationId === operation.id)?.id ?? null
    );
  }
}
