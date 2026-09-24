export type Visibility = 'public' | 'anonymous' | 'hidden';
export type RequestState = 'accepting' | 'accepted' | 'delivered' | 'cancelled';
export type PaymentState = 'authorized' | 'captured' | 'released' | 'refunded';
export type Role = 'client' | 'creator';

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
  cancelledReason: string | null;
  paymentState: PaymentState;
}
export interface SessionView {
  name: string;
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
export type RequestLinkState = 'pending' | 'accepted' | 'cancelled';
export interface RequestLinkView {
  id: string;
  delivery: LinkDelivery;
  /** Shown to the sender only. */
  recipientEmail: string | null;
  recipientName: string;
  clientName: string;
  brief: string;
  amount: number;
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
}
export const requestLabels: Record<RequestState, string> = {
  accepting: '支払確認中',
  accepted: '制作中',
  delivered: '納品済み',
  cancelled: 'キャンセル',
};
export const paymentLabels: Record<PaymentState, string> = {
  authorized: '確保済み',
  captured: '支払済み',
  released: '確保解除済み',
  refunded: '返金済み',
};
