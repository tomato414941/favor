import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecipientView } from '../src/shared';
import { api } from './api';
import { navigate } from './ui';

const returnKey = 'favor.recipient-return';
export function RecipientAccount({
  userId,
  full = false,
  onReady,
}: {
  userId: string;
  full?: boolean;
  onReady?: (ready: boolean) => void;
}) {
  const [account, setAccount] = useState<RecipientView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ticket = useRef(0);
  const action = useRef(new URLSearchParams(window.location.search).get('onboarding'));
  const started = useRef(false);
  const load = useCallback(async () => {
    const current = ++ticket.current;
    const value = await api<RecipientView>('/recipient');
    if (current === ticket.current) {
      setAccount(value);
      setError('');
    }
  }, []);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void load().catch(() => setError('受取先を確認できません。'));
    };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      ticket.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);
  useEffect(() => {
    onReady?.(account?.state === 'ready');
  }, [account?.state, onReady]);
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
        navigate(saved.path);
        return;
      }
    } catch {
      /* The received list remains available when tab storage is disabled. */
    }
    navigate('/me/received');
  }
  async function open(path: 'onboard' | 'dashboard') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { url } = await api<{ url: string | null }>(`/recipient/${path}`, { body: {} });
      if (url) {
        // The private request fragment stays in this tab; Stripe receives a fixed return URL.
        if (!full && path === 'onboard') {
          try {
            sessionStorage.setItem(
              returnKey,
              JSON.stringify({
                userId,
                path: window.location.pathname + window.location.hash,
              }),
            );
          } catch {
            /* The browser's Back button still returns to the private link. */
          }
        }
        window.location.assign(url);
      } else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登録画面を開けません。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!full || started.current) return;
    started.current = true;
    if (action.current) window.history.replaceState(null, '', window.location.pathname);
    if (action.current === 'refresh') void open('onboard');
  }, [full]);
  useEffect(() => {
    if (full && action.current === 'return' && account?.state === 'ready') {
      action.current = null;
      returnToRequest();
    }
  }, [full, account?.state]);
  if (!full && account?.state === 'ready') return null;
  return (
    <section
      className={full ? 'request-detail recipient-account' : 'recipient-account'}
      aria-label="売上の受け取り"
    >
      <h2>売上の受け取り</h2>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {!account ? (
        error ? (
          <button
            className="text-button"
            onClick={() => void load().catch(() => setError('受取先を確認できません。'))}
          >
            再読み込み
          </button>
        ) : (
          <p role="status">確認しています…</p>
        )
      ) : (
        <>
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
              <button className="primary" disabled={busy} onClick={() => void open('onboard')}>
                {account.state === 'unregistered' ? '受取先を登録' : '登録を続ける'}
              </button>
            )}
            {account.state === 'ready' && (
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() => void open('dashboard')}
              >
                Stripeを開く
              </button>
            )}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void load().catch(() => setError('受取先を確認できません。'))}
            >
              登録状況を確認
            </button>
            {full && (
              <button className="text-button" onClick={returnToRequest}>
                依頼に戻る
              </button>
            )}
          </div>
          {full && account.state === 'ready' && (
            <p className="hint">入金予定と口座の変更はStripeで確認できます。</p>
          )}
        </>
      )}
    </section>
  );
}
