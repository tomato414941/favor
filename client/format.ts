import type { Visibility } from '../src/shared';

export const number = new Intl.NumberFormat('ja-JP');
export const yen = (value: number) => `¥${number.format(value)}`;
const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
export const date = (value: number) => dateFormat.format(value);
export const visibilityLabels: Record<Visibility, string> = {
  public: '公開',
  anonymous: '匿名',
  hidden: '非表示',
};
