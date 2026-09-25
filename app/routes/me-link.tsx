import { useEffect, useRef, useState } from 'react';
import { data, Link, useFetcher, useLocation, useNavigate } from 'react-router';
import type { Route } from './+types/me-link';
import type { RequestLinkResult } from '../../src/shared';
import { LinkFacts, LinkStatus } from '../components/Links';
import { clientAction } from '../components/retry';
import { Arrow, ConfirmAction, useOperationKey, type ActionFailure } from '../components/ui';
import { favorOf } from '../server/context';
import { linkIntent } from '../server/links';
import { attempt, field, operationKey, requireIdentity } from '../server/session';
import { useMe } from './me';

export { clientAction };
type Outcome = ActionFailure & Partial<RequestLinkResult>;
type Intent = 'checkout' | 'complete' | 'reissue' | 'withdraw';

/** Card entry, creation after the card is held, reissue, and withdrawal of one link. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const form = await args.request.formData();
  return attempt(async () => {
    const result = await linkIntent(
      favor,
      who.account.subject,
      args.params.id,
      field(form, 'intent'),
      operationKey(form),
      favor.pageOrigin(args.request),
    );
    if (!result)
      return data(
        { error: { code: 'INVALID_INPUT', message: '操作を確認できませんでした。' } },
        { status: 400 },
      );
    return result;
  });
}

export default function LinkPage({ params }: Route.ComponentProps) {
  const { links } = useMe();
  const link = links.find((item) => item.id === params.id);
  const location = useLocation();
  const navigate = useNavigate();
  const fetcher = useFetcher<Outcome>();
  const operation = useOperationKey();
  const arrived = (location.state ?? {}) as { token?: string; notice?: string };
  const [url, setUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState(arrived.notice ?? '');
  const returned = useRef(false);
  const last = useRef<Intent | null>(null);
  const busy = fetcher.state !== 'idle';
  useEffect(() => {
    if (arrived.token) setUrl(`${window.location.origin}/link#${arrived.token}`);
    if (arrived.token || arrived.notice)
      void navigate(location.pathname + location.search, { replace: true, state: null });
  }, []);
  function submit(intent: Intent) {
    if (!link) return;
    last.current = intent;
    setNotice('');
    if (intent === 'reissue') setUrl(null);
    void fetcher.submit(
      { intent, key: operation.keyFor({ intent, id: link.id }) },
      { method: 'post' },
    );
  }
  // Back from card entry: finish creating the link once.
  useEffect(() => {
    if (!link || returned.current) return;
    if (new URLSearchParams(location.search).get('payment') !== 'return') return;
    returned.current = true;
    void navigate(location.pathname, { replace: true });
    submit('complete');
  }, [link?.id]);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.link) return;
    const { link: updated, token, checkoutUrl } = fetcher.data;
    operation.done();
    if (checkoutUrl) {
      window.location.assign(checkoutUrl);
      return;
    }
    setUrl(token ? `${window.location.origin}/link#${token}` : null);
    const intent = last.current;
    const mailed = updated.delivery === 'email';
    setNotice(
      intent === 'withdraw'
        ? '依頼を取り消しました。'
        : intent === 'complete'
          ? mailed
            ? 'メールで送りました。'
            : 'リンクを作成しました。'
          : mailed
            ? '新しいリンクをメールで送り直しました。'
            : token
              ? 'リンクを再発行しました。'
              : '再発行済みのリンクを表示できません。もう一度再発行してください。',
    );
  }, [fetcher.state, fetcher.data]);
  async function copy() {
    if (!url) return;
    if (!navigator.clipboard) {
      setNotice('リンク欄を選択してコピーしてください。');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice('リンクをコピーしました。');
    } catch {
      setNotice('コピーできませんでした。リンク欄を選択してコピーしてください。');
    }
  }
  return (
    <div className="detail-page">
      <Link className="back-link" to="/me/sent">
        送った依頼へ
      </Link>
      {fetcher.data?.error && (
        <div className="message error" role="alert">
          {fetcher.data.error.message}
        </div>
      )}
      {notice && !busy && (
        <div className="message success" role="status">
          {notice}
        </div>
      )}
      {link ? (
        <article className="request-detail" key={link.id} aria-label="依頼リンク">
          <div className="detail-heading">
            <h1>{link.delivery === 'email' ? link.recipientEmail : 'リンクで共有'}</h1>
            <LinkStatus link={link} />
          </div>
          <LinkFacts link={link} />
          {link.state === 'awaiting_payment' ? (
            <div className="detail-actions">
              {link.paymentState === 'authorized' ? (
                <button className="primary" disabled={busy} onClick={() => submit('complete')}>
                  {link.delivery === 'email' ? 'メールで送る' : 'リンクを作成'}
                  <Arrow />
                </button>
              ) : (
                <>
                  <button className="primary" disabled={busy} onClick={() => submit('checkout')}>
                    カード入力へ
                    <Arrow />
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => submit('complete')}
                  >
                    入力済みの支払いを確認
                  </button>
                </>
              )}
              <ConfirmAction
                label="取り消す"
                question="この依頼を取り消しますか？"
                busy={busy}
                onConfirm={() => submit('withdraw')}
              />
            </div>
          ) : link.state === 'pending' ? (
            <div className="request-link-share">
              {link.delivery === 'self' && (
                <>
                  {url ? (
                    <>
                      <label htmlFor={`link-${link.id}`}>依頼リンク</label>
                      <div className="link-row">
                        <input
                          id={`link-${link.id}`}
                          className="text-input"
                          value={url}
                          readOnly
                          onFocus={(event) => event.target.select()}
                        />
                        <button
                          className="quiet-button"
                          disabled={busy}
                          onClick={() => void copy()}
                        >
                          コピー
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="hint">共有するリンクが必要な場合は再発行してください。</p>
                  )}
                  <p className="hint">
                    リンクを知っている人が開けます。相手だけに共有してください。
                  </p>
                </>
              )}
              <div className="link-management">
                <ConfirmAction
                  label={link.delivery === 'email' ? 'メールを送り直す' : 'リンクを再発行'}
                  question={
                    link.delivery === 'email'
                      ? '新しいリンクをメールで送りますか？'
                      : 'リンクを再発行しますか？'
                  }
                  description={`${link.delivery === 'email' ? link.recipientEmail + 'へ送ります。' : ''}古いリンクは使えなくなります。期限は変わりません。`}
                  busy={busy}
                  onConfirm={() => submit('reissue')}
                />
                <ConfirmAction
                  label="取り消す"
                  question="この依頼を取り消しますか？"
                  description="リンクを無効にし、支払確保を解除します。"
                  busy={busy}
                  onConfirm={() => submit('withdraw')}
                />
              </div>
            </div>
          ) : link.requestId ? (
            <Link className="quiet-button" to={`/me/requests/${link.requestId}`}>
              依頼を開く
            </Link>
          ) : (
            <p className="cancellation-note">
              {link.cancelledReason === 'declined'
                ? '相手が依頼を見送りました。'
                : link.cancelledReason === 'expired'
                  ? '受諾期限を過ぎました。'
                  : link.cancelledReason === 'undeliverable'
                    ? 'メールを送信できませんでした。'
                    : link.cancelledReason === 'recipient_blocked'
                      ? '相手がメールでの依頼を受け取らない設定にしています。'
                      : '依頼を取り消しました。'}
              {link.paymentState === 'released'
                ? '仮押さえを解除しました。'
                : '仮押さえの解除を確認しています。'}
            </p>
          )}
        </article>
      ) : (
        <p className="empty-state">依頼が見つかりません</p>
      )}
    </div>
  );
}
