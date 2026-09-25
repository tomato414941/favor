import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useFetcher } from 'react-router';
import { requestLabels, type RequestView, type Role } from '../../src/shared';
import { PaymentFacts } from './PaymentFacts';
import { AmountFacts } from './AmountFacts';
import { Arrow, ConfirmAction, useOperationKey, type ActionFailure } from './ui';
import { date, number, visibilityLabels } from './format';

interface Limits {
  files: number;
  uploadBytes: number;
}
type Outcome = ActionFailure & { request?: RequestView; notice?: string };

const reasons: Record<string, string> = {
  withdrawn: '依頼を取り消しました。',
  declined: '作り手が依頼を見送りました。',
  give_up: '作り手が制作を終了しました。',
  acceptance_expired: '受諾期限を過ぎました。',
  delivery_expired: '納品期限を過ぎました。',
  payment_expired: '支払いの確認期限を過ぎました。',
};
export function RequestStatus({ request }: { request: RequestView }) {
  return <span className={`status status-${request.state}`}>{requestLabels[request.state]}</span>;
}
export function RequestDetail({
  request,
  role,
  limits,
}: {
  request: RequestView;
  role: Role;
  limits: Limits;
}) {
  const fetcher = useFetcher<Outcome>();
  const cancelKey = useOperationKey();
  const busy = fetcher.state !== 'idle';
  const canDeliver =
    role === 'creator' &&
    ['accepted', 'delivered'].includes(request.state) &&
    Date.now() < request.deliverBy;
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [request.deliveryVersion]);
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.request) cancelKey.done();
  }, [fetcher.state, fetcher.data]);
  return (
    <article className="request-detail" aria-label="依頼の詳細">
      <div className="detail-heading">
        <h1>{role === 'creator' ? `${request.clientName}から` : `${request.creatorName}へ`}</h1>
        <RequestStatus request={request} />
      </div>
      {fetcher.data?.error && (
        <div className="message error" role="alert">
          {fetcher.data.error.message}
        </div>
      )}
      {fetcher.data?.notice && !busy && (
        <div className="message success" role="status">
          {fetcher.data.notice}
        </div>
      )}
      {request.state === 'delivered' && request.visibility !== 'hidden' && (
        <p className="hint">
          <Link to={`/works/${request.id}`}>作品ページを見る</Link>
        </p>
      )}
      <div className="brief-block">
        <p>{request.brief}</p>
      </div>
      <dl className="detail-facts">
        <AmountFacts {...request} recipient={role === 'creator'} />
        <div>
          <dt>公開設定</dt>
          <dd>{visibilityLabels[request.visibility]}</dd>
        </div>
        <div>
          <dt>作成日時</dt>
          <dd>{date(request.createdAt)}</dd>
        </div>
        <div>
          <dt>受諾期限</dt>
          <dd>{date(request.acceptBy)}</dd>
        </div>
        <div>
          <dt>納品期限</dt>
          <dd>{date(request.deliverBy)}</dd>
        </div>
        <PaymentFacts
          state={request.paymentState}
          amount={request.amount}
          settlement={request.settlement}
        />
      </dl>
      {request.state === 'cancelled' && (
        <div className="cancellation-note">
          <h3>キャンセル済み</h3>
          <p>
            {reasons[request.cancelledReason ?? ''] ?? '取引は終了しています。'}
            {request.paymentState === 'released'
              ? '仮押さえを解除しました。'
              : '仮押さえの解除を確認しています。'}
          </p>
        </div>
      )}
      {request.state === 'delivering' && (
        <div className="payment-pending">
          支払いを確認しています。確認が済むと、ファイルを相手に渡します。
        </div>
      )}
      {role === 'creator' && request.paymentState === 'captured' && (
        <p className="hint">
          {request.transferState === 'held'
            ? '売上の送金を保留しています。'
            : request.transferState === 'recovery_pending'
              ? '取消分の売上を調整しています。'
              : request.transferState === 'recovered'
                ? '売上を取り消しました。'
                : request.transferState === 'transferred'
                  ? '売上をStripeに反映しました。'
                  : '売上を処理しています。'}{' '}
          <Link to="/me/settings">受取先を確認</Link>
        </p>
      )}
      {request.files.length > 0 && (
        <section className="delivery-files">
          <h3>
            届いたファイル <span>第{request.deliveryVersion}版</span>
          </h3>
          {request.files.map((file) => (
            <a
              key={file.id}
              href={`/me/requests/${request.id}/files/${file.id}`}
              download={file.name}
            >
              <span>
                <strong>{file.name}</strong>
                <small>{number.format(Math.max(1, Math.ceil(file.size / 1024)))} KB</small>
              </span>
              <Arrow down />
            </a>
          ))}
        </section>
      )}
      {canDeliver &&
        (request.state === 'delivered' ? (
          <section className="redelivery">
            {replacing ? (
              <>
                <button className="text-button" disabled={busy} onClick={() => setReplacing(false)}>
                  差し替えをやめる
                </button>
                <DeliveryForm request={request} limits={limits} fetcher={fetcher} />
              </>
            ) : (
              <button className="quiet-button" disabled={busy} onClick={() => setReplacing(true)}>
                作品を差し替える
              </button>
            )}
          </section>
        ) : (
          <DeliveryForm request={request} limits={limits} fetcher={fetcher} />
        ))}
      {role === 'creator' && request.state === 'accepted' && (
        <div className="cancel-action">
          <ConfirmAction
            label="中止する"
            question="この依頼を中止しますか？"
            description="カードの仮押さえを解除します。"
            busy={busy}
            onConfirm={() =>
              void fetcher.submit(
                { intent: 'cancel', key: cancelKey.keyFor({ cancel: request.id }) },
                { method: 'post' },
              )
            }
          />
        </div>
      )}
    </article>
  );
}

function DeliveryForm({
  request,
  limits,
  fetcher,
}: {
  request: RequestView;
  limits: Limits;
  fetcher: ReturnType<typeof useFetcher<Outcome>>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const operation = useOperationKey();
  const busy = fetcher.state !== 'idle';
  function deliver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (
      files.length < 1 ||
      files.length > limits.files ||
      files.some((file) => file.size === 0) ||
      files.reduce((sum, file) => sum + file.size, 0) > limits.uploadBytes
    ) {
      setError(
        `空でないファイルを1〜${limits.files}個、合計${limits.uploadBytes / 1024 / 1024} MB以内で選んでください。`,
      );
      return;
    }
    const form = new FormData();
    form.set('intent', 'deliver');
    form.set(
      'key',
      operation.keyFor(files.map((file) => [file.name, file.size, file.lastModified])),
    );
    for (const file of files) form.append('files', file, file.name);
    void fetcher.submit(form, { method: 'post', encType: 'multipart/form-data' });
  }
  useEffect(() => {
    setFiles([]);
    operation.done();
    if (input.current) input.current.value = '';
  }, [request.deliveryVersion]);
  return (
    <form className="delivery-form" onSubmit={deliver}>
      <label className="upload-label" htmlFor={`files-${request.id}`}>
        納品ファイルを選択
      </label>
      <div className="upload-control">
        <input
          ref={input}
          id={`files-${request.id}`}
          type="file"
          multiple
          required
          disabled={busy}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
            setError('');
          }}
        />
        <span className="file-pick-button" aria-hidden="true">
          ファイルを選ぶ
        </span>
        <span className="file-pick-caption" aria-hidden="true">
          {files.length ? `${files.length}個のファイル` : '選択されていません'}
        </span>
      </div>
      <p className="hint">
        最大{limits.files}ファイル · 合計{limits.uploadBytes / 1024 / 1024} MBまで ·{' '}
        {date(request.deliverBy)}まで
      </p>
      {files.length > 0 && (
        <ul className="selected-files">
          {files.map((file, index) => (
            <li key={`${file.name}:${index}`}>{file.name}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '送っています…' : request.state === 'delivered' ? '差し替える' : '作品を渡す'}
        <Arrow />
      </button>
    </form>
  );
}
