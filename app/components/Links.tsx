import { paymentLabels, type RequestLinkView } from '../../src/shared';
import { AmountFacts } from './AmountFacts';
import { date, visibilityLabels } from './format';

export function LinkFacts({
  link,
  recipient = false,
}: {
  link: RequestLinkView;
  recipient?: boolean;
}) {
  return (
    <>
      <div className="brief-block">
        <p>{link.brief}</p>
      </div>
      <dl className="detail-facts">
        <AmountFacts {...link} recipient={recipient} />
        <div>
          <dt>公開設定</dt>
          <dd>{visibilityLabels[link.visibility]}</dd>
        </div>
        <div>
          <dt>作成日時</dt>
          <dd>{date(link.createdAt)}</dd>
        </div>
        {link.state !== 'awaiting_payment' && (
          <>
            <div>
              <dt>受諾期限</dt>
              <dd>{date(link.expiresAt)}</dd>
            </div>
            <div>
              <dt>納品期限</dt>
              <dd>{date(link.deliverBy)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>支払い</dt>
          <dd>カード · {paymentLabels[link.paymentState]}</dd>
        </div>
      </dl>
    </>
  );
}

export function LinkStatus({ link }: { link: RequestLinkView }) {
  return (
    <span className={`status status-${link.state}`}>
      {link.state === 'awaiting_payment'
        ? link.paymentState === 'authorized'
          ? '作成待ち'
          : 'カード入力待ち'
        : link.state === 'pending'
          ? '受諾待ち'
          : link.state === 'accepted'
            ? '受諾済み'
            : '受付終了'}
    </span>
  );
}
