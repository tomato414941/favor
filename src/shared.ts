export type Visibility = 'public' | 'anonymous' | 'hidden';
export type PaymentMethod = 'card' | 'points';
export type RequestState = 'awaiting_acceptance' | 'accepting' | 'accepted' | 'delivered' | 'cancelled';
export type PaymentState = 'authorized' | 'captured' | 'released' | 'refunded';
export type Role = 'client' | 'creator';

export interface RequestInput {
  creatorId: string;
  brief: string;
  amount: number;
  visibility: Visibility;
  paymentMethod: PaymentMethod;
  nsfw: boolean;
  agreeToRules: boolean;
}
export interface UploadInput { name: string; content: string }
export interface FileView { id: string; name: string; size: number }
export interface RequestView {
  id: string;
  viewerRole?: Role;
  brief: string;
  amount?: number;
  clientName: string;
  creatorName: string;
  visibility: Visibility;
  nsfw: boolean;
  state: RequestState;
  createdAt: number;
  acceptBy: number;
  deliverBy: number;
  cancelledReason: string | null;
  paymentMethod?: PaymentMethod;
  paymentState?: PaymentState;
  deliveryVersion: number;
  files: FileView[];
}
export interface SessionView {
  role: Role;
  name: string;
  pointsBalance: number;
  pointsAvailable: number;
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
  invitationLookup: boolean;
  localLogin?: boolean;
}
export interface LocalCredentials { email: string; password: string }
export interface LocalRegistration extends LocalCredentials { agreeToRules: boolean }
export interface LocalMigration extends LocalCredentials { login: string }
export interface InvitationInput {
  recipientHandle: string;
  brief: string;
  amount: number;
  visibility: Visibility;
  nsfw: boolean;
  agreeToRules: boolean;
}
export type InvitationState = 'pending' | 'accepted' | 'cancelled';
export interface InvitationView {
  id: string;
  recipientName: string;
  recipientHandle: string;
  clientName: string;
  brief: string;
  amount: number;
  visibility: Visibility;
  nsfw: boolean;
  state: InvitationState;
  paymentState: PaymentState;
  createdAt: number;
  expiresAt: number;
  deliverBy: number;
  cancelledReason: string | null;
  requestId: string | null;
}
export interface InvitationLinkResult {
  invitation: InvitationView;
  /** Returned once. A lost response can be recovered by explicitly reissuing the link. */
  token?: string;
}
export type RequestLinkInput = Omit<InvitationInput, 'recipientHandle'>;
export type RequestLinkView = Omit<InvitationView, 'recipientHandle'>;
export interface RequestLinkResult { link: RequestLinkView; token?: string }
export interface CreatorView {
  id: string; name: string; recommendedAmount: number; minimumAmount: number;
  acceptanceDays: number; deliveryDays: number;
}
export const requestLabels: Record<RequestState, string> = {
  awaiting_acceptance: '承認待ち', accepting: '支払確認中', accepted: '制作中',
  delivered: '納品済み', cancelled: 'キャンセル',
};
export const paymentLabels: Record<PaymentState, string> = {
  authorized: '確保済み', captured: '支払済み', released: '確保解除済み', refunded: '返金・返還済み',
};
