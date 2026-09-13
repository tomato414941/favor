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
