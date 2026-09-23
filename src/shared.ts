export type Visibility = 'public' | 'anonymous' | 'hidden';
export type RequestState = 'accepting' | 'accepted' | 'delivered' | 'cancelled';
export type PaymentState = 'authorized' | 'captured' | 'released' | 'refunded';
export type Role = 'client' | 'creator';

export interface RequestLinkInput {
  brief: string;
  amount: number;
  visibility: Visibility;
  nsfw: boolean;
  agreeToRules: boolean;
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
  nsfw: boolean;
  state: RequestState;
  createdAt: number;
  acceptBy: number;
  deliverBy: number;
  deliveryVersion: number;
}
export interface RequestView extends WorkView {
  viewerRole: Role;
  amount: number;
  cancelledReason: string | null;
  paymentState: PaymentState;
  files: FileView[];
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
  mode: 'local' | 'demo' | 'x' | 'disabled';
  xLogin: boolean;
  localLogin?: boolean;
}
export interface LocalCredentials {
  email: string;
  password: string;
}
export type RequestLinkState = 'pending' | 'accepted' | 'cancelled';
export interface RequestLinkView {
  id: string;
  recipientName: string;
  clientName: string;
  brief: string;
  amount: number;
  visibility: Visibility;
  nsfw: boolean;
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
