export type Visibility = 'public' | 'anonymous' | 'hidden';
export type RequestState = 'delivering' | 'accepted' | 'delivered' | 'cancelled';
export type PaymentState =
  'pending' | 'authorized' | 'capturing' | 'captured' | 'releasing' | 'released';
export type Role = 'client' | 'creator';
export const PLATFORM_FEE_PERCENT = 8;
export type RecipientState = 'unregistered' | 'incomplete' | 'reviewing' | 'ready';
export interface RecipientView {
  state: RecipientState;
}

export type LinkDelivery = 'self' | 'email';
export interface RequestLinkInput {
  brief: string;
  amount: number;
  visibility: Visibility;
  agreeToRules: boolean;
  /** self: the client hands over the URL. email: the service mails it to recipientEmail. */
  delivery?: LinkDelivery;
  recipientEmail?: string;
}
export interface UploadInput {
  name: string;
  content: string;
}
export interface FileView {
  id: string;
  name: string;
  size: number;
}
export interface WorkView {
  id: string;
  brief: string;
  clientName: string;
  creatorName: string;
  visibility: Visibility;
  state: RequestState;
  createdAt: number;
  acceptBy: number;
  deliverBy: number;
  deliveryVersion: number;
  files: FileView[];
}
export interface RequestView extends WorkView {
  viewerRole: Role;
  amount: number;
  platformFee: number;
  recipientAmount: number;
  cancelledReason: string | null;
  paymentState: PaymentState;
  transferState: 'pending' | 'transferred' | null;
}
export interface SessionView {
  name: string;
}
export interface ProfileView {
  /** The name shown to others. */
  name: string;
  /** The name the person chose, if any. */
  displayName: string | null;
}
export interface SocialAccount {
  provider: string;
  subject: string;
  handle: string;
  name: string;
}
export interface IdentitySession {
  account: SocialAccount;
  registered: boolean;
  email?: string;
}
export interface AuthOptions {
  /** clerk: sign-in through Clerk. demo: local sign-in by address, loopback only. */
  mode: 'clerk' | 'demo';
  publishableKey?: string;
}
export type RequestLinkState = 'awaiting_payment' | 'pending' | 'accepted' | 'cancelled';
export interface RequestLinkView {
  id: string;
  delivery: LinkDelivery;
  /** Shown to the sender only. */
  recipientEmail: string | null;
  recipientName: string;
  clientName: string;
  brief: string;
  amount: number;
  platformFee: number;
  recipientAmount: number;
  visibility: Visibility;
  state: RequestLinkState;
  paymentState: PaymentState;
  createdAt: number;
  expiresAt: number;
  deliverBy: number;
  cancelledReason: string | null;
  requestId: string | null;
}
export interface RequestLinkResult {
  link: RequestLinkView;
  /** Returned once. A lost response can be recovered by explicitly reissuing the link. */
  token?: string;
  checkoutUrl?: string;
}
export const requestLabels: Record<RequestState, string> = {
  delivering: '納品確認中',
  accepted: '制作中',
  delivered: '納品済み',
  cancelled: 'キャンセル',
};
export const paymentLabels: Record<PaymentState, string> = {
  pending: 'カード入力待ち',
  authorized: '仮押さえ済み',
  capturing: '支払確認中',
  releasing: '解除手続き中',
  captured: '支払済み',
  released: '確保解除済み',
};
