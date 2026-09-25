import { yen } from './format';
import { recipientEntitlement, type SettlementView } from '../../src/shared';

export function AmountFacts({
  amount,
  platformFee,
  recipientAmount,
  recipient = false,
  settlement,
}: {
  amount: number;
  platformFee: number;
  recipientAmount: number;
  recipient?: boolean;
  settlement?: SettlementView;
}) {
  const adjusted = settlement
    ? recipientEntitlement(amount, recipientAmount, settlement)
    : recipientAmount;
  return (
    <>
      <div className={recipient ? undefined : 'amount-total'}>
        <dt>金額</dt>
        <dd>{yen(amount)}</dd>
      </div>
      {recipient && (
        <>
          <div>
            <dt>利用料（税込）</dt>
            <dd>−{yen(platformFee)}</dd>
          </div>
          <div className="amount-total">
            <dt>{adjusted === recipientAmount ? '受取額' : '当初の受取額'}</dt>
            <dd>{yen(recipientAmount)}</dd>
          </div>
          {adjusted !== recipientAmount && (
            <div className="amount-total">
              <dt>調整後の受取額</dt>
              <dd>{yen(adjusted)}</dd>
            </div>
          )}
        </>
      )}
    </>
  );
}
