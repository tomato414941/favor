import { paymentLabels, type PaymentState, type SettlementView } from '../../src/shared';
import { yen } from './format';

export function PaymentFacts({
  state,
  amount,
  settlement,
}: {
  state: PaymentState;
  amount: number;
  settlement: SettlementView;
}) {
  const label =
    state !== 'captured'
      ? paymentLabels[state]
      : settlement.disputedAmount > 0
        ? settlement.disputedAmount + settlement.refunded >= amount
          ? '支払い取消'
          : '一部支払い取消'
        : settlement.refunded > 0
          ? settlement.refunded >= amount
            ? '返金済み'
            : '一部返金済み'
          : paymentLabels[state];
  return (
    <>
      <div>
        <dt>支払い</dt>
        <dd>カード · {label}</dd>
      </div>
      {settlement.refunded > 0 && (
        <div>
          <dt>返金済み</dt>
          <dd>{yen(settlement.refunded)}</dd>
        </div>
      )}
      {settlement.refundPending > 0 && (
        <div>
          <dt>返金手続き中</dt>
          <dd>{yen(settlement.refundPending)}</dd>
        </div>
      )}
      {settlement.refundFailed > 0 && (
        <div>
          <dt>返金失敗</dt>
          <dd>{yen(settlement.refundFailed)}</dd>
        </div>
      )}
      {settlement.dispute !== 'none' && (
        <div>
          <dt>カード会社への異議申し立て</dt>
          <dd>
            {settlement.dispute === 'open'
              ? '確認中'
              : settlement.dispute === 'lost'
                ? '支払い取消'
                : '支払い確定'}
          </dd>
        </div>
      )}
    </>
  );
}
