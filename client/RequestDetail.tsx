import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  paymentLabels,
  requestLabels,
  type RequestView,
  type Role,
  type UploadInput,
} from '../src/shared';
import { encodeFile } from './api';
import { Arrow } from './ui';
import { date, number, visibilityLabels, yen } from './format';

interface Limits {
  files: number;
  uploadBytes: number;
}
export type RequestAction = { type: 'cancel' } | { type: 'deliver'; files: UploadInput[] };
export type RequestActionHandler = (request: RequestView, action: RequestAction) => Promise<void>;

const reasons: Record<string, string> = {
  withdrawn: '依頼を取り消しました。',
  declined: '作り手が依頼を見送りました。',
  give_up: '作り手が制作を終了しました。',
  acceptance_expired: '受諾期限を過ぎました。',
  delivery_expired: '納品期限を過ぎました。',
  payment_expired: '支払いの確認期限を過ぎました。',
};
export function RequestStatus({ request }: { request: RequestView }) {
  return (
    <span className={`status status-${request.state}`}>
      <i />
      {requestLabels[request.state]}
    </span>
  );
}
export function RequestDetail({
  request,
  role,
  limits,
  busy,
  act,
}: {
  request: RequestView;
  role: Role;
  limits: Limits;
  busy: boolean;
  act: RequestActionHandler;
}) {
  const canDeliver =
    role === 'creator' &&
    ['accepted', 'delivered'].includes(request.state) &&
    Date.now() < request.deliverBy;
  function cancel() {
    const message = '制作をギブアップし、依頼者に返金しますか？';
    if (window.confirm(message)) void act(request, { type: 'cancel' });
  }
  return (
    <article className="request-detail" aria-label="依頼の詳細">
      <div className="detail-heading">
        <h2>依頼の詳細</h2>
        <RequestStatus request={request} />
      </div>
      <p className="detail-parties">
        {request.clientName} <Arrow /> {request.creatorName}
      </p>
      {request.state !== 'cancelled' && (
        <ol className="timeline" aria-label="取引の流れ">
          {['依頼を作成', '受諾・制作', '納品'].map((label, index) => {
            const step = request.state === 'delivered' ? 2 : request.state === 'accepted' ? 1 : 0;
            return (
              <li
                className={index <= step ? 'reached' : ''}
                aria-current={index === step ? 'step' : undefined}
                key={label}
              >
                <span>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>
                {label}
              </li>
            );
          })}
        </ol>
      )}
      <div className="brief-block">
        <div className="brief-label">
          依頼内容 {request.nsfw && <span className="nsfw-label">閲覧注意</span>}
        </div>
        <p>{request.brief}</p>
      </div>
      <dl className="detail-facts">
        <div>
          <dt>依頼金額</dt>
          <dd>{yen(request.amount)}</dd>
        </div>
        <div>
          <dt>公開範囲</dt>
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
        <div>
          <dt>支払い</dt>
          <dd>カード · {paymentLabels[request.paymentState]}</dd>
        </div>
      </dl>
      {request.state === 'cancelled' && (
        <div className="cancellation-note">
          <h3>この依頼はキャンセルされました</h3>
          <p>
            {reasons[request.cancelledReason ?? ''] ?? '取引は終了しています。'}
            {request.paymentState === 'refunded'
              ? 'カードへの返金処理が完了しました。'
              : '支払確保を解除しました。'}
          </p>
        </div>
      )}
      {request.state === 'accepting' && (
        <div className="payment-pending">
          支払いの確認を待っています。制作は確認が完了してから始めてください。
        </div>
      )}
      {request.files.length > 0 && (
        <section className="delivery-files">
          <h3>
            届いたファイル <span>第{request.deliveryVersion}版</span>
          </h3>
          {request.files.map((file) => (
            <a key={file.id} href={`/api/files/${file.id}`} download={file.name}>
              <span>
                <strong>{file.name}</strong>
                <small>{number.format(Math.max(1, Math.ceil(file.size / 1024)))} KB</small>
              </span>
              <Arrow down />
            </a>
          ))}
        </section>
      )}
      {role === 'client' && request.state === 'accepted' && (
        <p className="waiting-note">作り手が制作しています。作品が届くのをお待ちください。</p>
      )}
      {canDeliver &&
        (request.state === 'delivered' ? (
          <details className="redelivery">
            <summary>ファイルを再納品する</summary>
            <p className="hint">元の納品期限まで、作り手の判断でファイルを差し替えられます。</p>
            <DeliveryForm request={request} limits={limits} busy={busy} act={act} />
          </details>
        ) : (
          <DeliveryForm request={request} limits={limits} busy={busy} act={act} />
        ))}
      {role === 'creator' && request.state === 'accepted' && (
        <button className="give-up" onClick={cancel} disabled={busy}>
          制作をギブアップする
        </button>
      )}
      <p className="detail-demo-note">支払い・返金は体験用です。実際のお金は動きません。</p>
    </article>
  );
}

function DeliveryForm({
  request,
  limits,
  busy,
  act,
}: {
  request: RequestView;
  limits: Limits;
  busy: boolean;
  act: RequestActionHandler;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function deliver(event: FormEvent) {
    event.preventDefault();
    if (reading || busy) return;
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
    setReading(true);
    try {
      const encoded = await Promise.all(files.map(encodeFile));
      await act(request, { type: 'deliver', files: encoded });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ファイルを読み取れませんでした。');
    } finally {
      setReading(false);
    }
  }
  useEffect(() => {
    setFiles([]);
    if (input.current) input.current.value = '';
  }, [request.deliveryVersion]);
  return (
    <form className="delivery-form" onSubmit={(event) => void deliver(event)}>
      <h3>作品を届ける</h3>
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
          disabled={busy || reading}
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
      <button className="primary" type="submit" disabled={busy || reading}>
        {busy || reading ? '納品しています…' : 'ファイルを納品'}
        <Arrow />
      </button>
    </form>
  );
}
