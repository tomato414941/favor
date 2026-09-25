import { useEffect, useRef } from 'react';
import { useFetcher, useNavigate, useSearchParams } from 'react-router';
import type { RecipientView } from '../../src/shared';
import type { ActionFailure } from './ui';

const returnKey = 'favor.recipient-return';
type Result = ActionFailure & { url?: string | null };

/**
 * Sign-up for payouts at Stripe. The compact form sits on a request; the full one is the payouts page,
 * which Stripe returns to and which then sends the person back to the request they came from.
 */
export function RecipientAccount({
  userId,
  account,
  action,
  full = false,
}: {
  userId: string;
  account: RecipientView;
  /** The route whose action opens Stripe. */
  action: string;
  full?: boolean;
}) {
  const fetcher = useFetcher<Result>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const onboarding = useRef(full ? params.get('onboarding') : null);
  const started = useRef(false);
  const busy = fetcher.state !== 'idle';
  function open(intent: 'onboard' | 'dashboard') {
    if (busy) return;
    if (!full && intent === 'onboard') {
      // The private request fragment stays in this tab; Stripe receives a fixed return URL.
      try {
        sessionStorage.setItem(
          returnKey,
          JSON.stringify({ userId, path: window.location.pathname + window.location.hash }),
        );
      } catch {
        /* The browser's Back button still returns to the private link. */
      }
    }
    void fetcher.submit({ intent }, { method: 'post', action });
  }
  function returnToRequest() {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(returnKey) ?? 'null');
      sessionStorage.removeItem(returnKey);
      if (
        saved &&
        typeof saved === 'object' &&
        'userId' in saved &&
        saved.userId === userId &&
        'path' in saved &&
        typeof saved.path === 'string' &&
        /^\/link#[A-Za-z0-9_-]{43}$/.test(saved.path)
      ) {
        void navigate(saved.path);
        return;
      }
    } catch {
      /* The received list remains available when tab storage is disabled. */
    }
    void navigate('/me/received');
  }
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.url) return;
    window.location.assign(fetcher.data.url);
  }, [fetcher.state, fetcher.data]);
  useEffect(() => {
    if (!full || started.current) return;
    started.current = true;
    if (onboarding.current) void navigate(window.location.pathname, { replace: true });
    if (onboarding.current === 'refresh') open('onboard');
  }, [full]);
  useEffect(() => {
    if (full && onboarding.current === 'return' && account.state === 'ready') {
      onboarding.current = null;
      returnToRequest();
    }
  }, [full, account.state]);
  if (!full && account.state === 'ready') return null;
  return (
    <section className="recipient-account" aria-label={full ? '受取先' : '売上の受け取り'}>
      {!full && <h2>売上の受け取り</h2>}
      {fetcher.data?.error && (
        <p className="message error" role="alert">
          {fetcher.data.error.message}
        </p>
      )}
      <p>
        {account.state === 'ready'
          ? '登録済み'
          : account.state === 'reviewing'
            ? 'Stripeで確認中です。'
            : account.state === 'incomplete'
              ? '登録内容を確認してください。'
              : 'メールアドレスをStripeに共有し、本人確認と口座登録へ進みます。'}
      </p>
      <div className="action-buttons">
        {account.state !== 'ready' && (
          <button className="primary" disabled={busy} onClick={() => open('onboard')}>
            {account.state === 'unregistered' ? '受取先を登録' : '登録を続ける'}
          </button>
        )}
        {account.state === 'ready' && (
          <button className="quiet-button" disabled={busy} onClick={() => open('dashboard')}>
            Stripeを開く
          </button>
        )}
        {full && onboarding.current === 'return' && (
          <button className="text-button" onClick={returnToRequest}>
            依頼に戻る
          </button>
        )}
      </div>
      {full && account.state === 'ready' && (
        <p className="hint">入金予定と口座の変更はStripeで確認できます。</p>
      )}
    </section>
  );
}
