import { yen } from './format';

export function AmountFacts({
  amount,
  platformFee,
  recipientAmount,
  recipient = false,
}: {
  amount: number;
  platformFee: number;
  recipientAmount: number;
  recipient?: boolean;
}) {
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
            <dt>受取額</dt>
            <dd>{yen(recipientAmount)}</dd>
          </div>
        </>
      )}
    </>
  );
}
