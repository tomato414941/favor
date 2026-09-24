import { useRef, useState } from 'react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { Arrow, Link } from './ui';

const returnKey = 'favor.x-return';
const validReturn = (value: string) =>
  /^(?:\/link#[A-Za-z0-9_-]{43}|\/requests\/[A-Za-z0-9-]{1,100})$/.test(value) ? value : '';

export async function beginXLogin(returnTo = `${window.location.pathname}${window.location.hash}`) {
  try {
    // Check storage before leaving. Private link tokens never enter the OAuth state or a server URL.
    sessionStorage.setItem(
      returnKey,
      JSON.stringify({ location: validReturn(returnTo), at: Date.now() }),
    );
  } catch {
    throw new Error(
      'このブラウザーではログイン先から戻れません。サイトのデータ保存を許可して、もう一度お試しください。',
    );
  }
  try {
    const { url } = await api<{ url: string }>('/auth/x/start', { body: {} });
    const target = new URL(url);
    if (target.origin !== 'https://x.com' || target.pathname !== '/i/oauth2/authorize')
      throw new Error('ログイン先を確認できませんでした。');
    sessionStorage.setItem(
      returnKey,
      JSON.stringify({
        location: validReturn(returnTo),
        at: Date.now(),
        state: target.searchParams.get('state'),
      }),
    );
    window.location.assign(url);
  } catch (error) {
    sessionStorage.removeItem(returnKey);
    throw error;
  }
}

export function restoreXReturn(): { location: string; error: string } {
  const current = new URLSearchParams(window.location.hash.slice(1));
  const outcome = current.get('auth');
  if (!outcome)
    return { location: `${window.location.pathname}${window.location.hash}`, error: '' };
  let location = '/';
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey) ?? 'null');
    if (saved && saved.state === current.get('flow')) {
      sessionStorage.removeItem(returnKey);
      if (
        typeof saved.at === 'number' &&
        Date.now() - saved.at < 900_000 &&
        typeof saved.location === 'string'
      )
        location = validReturn(saved.location) || '/';
    }
  } catch {
    /* A regular login remains usable when the return location cannot be restored. */
  }
  const error =
    outcome === 'success'
      ? ''
      : outcome === 'cancelled'
        ? 'Xでの確認を中止しました。もう一度確認できます。'
        : outcome === 'expired'
          ? '確認の有効期限が切れました。もう一度Xでログインしてください。'
          : 'Xのアカウントを確認できませんでした。時間をおいてお試しください。';
  window.history.replaceState(null, '', location);
  return { location, error };
}

export function XLoginButton({
  label = 'Xでログイン',
  disabled = false,
}: {
  label?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login() {
    setBusy(true);
    setError('');
    try {
      await beginXLogin();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ログインを開始できませんでした。');
      setBusy(false);
    }
  }
  return (
    <div className="x-login-control">
      <button
        className="primary x-login-button"
        disabled={disabled || busy}
        onClick={() => void login()}
      >
        {busy ? 'Xを開いています…' : label}
        <Arrow />
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function EmailLoginForm({ onChange }: { onChange: () => void | Promise<void> }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function submit(verify: boolean) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      if (verify) {
        await api('/auth/email/verify', { body: { code } });
        setCode('');
        await onChange();
      } else {
        await api('/auth/email/start', { body: { email } });
        setEmail(email.trim().toLowerCase());
        setCode('');
        setSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="email-login-form"
      aria-label="メールでログイン"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(sent);
      }}
    >
      <fieldset disabled={busy} className="account-fields">
        {sent ? (
          <>
            <p role="status">{email} に確認コードを送りました</p>
            <div className="field">
              <label htmlFor="account-code">確認コード</label>
              <input
                key="code"
                id="account-code"
                className="text-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.normalize('NFKC').replace(/\s/g, ''))
                }
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                autoFocus
                required
              />
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="account-email">メールアドレス</label>
            <input
              key="email"
              id="account-email"
              className="text-input"
              type="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              required
            />
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '処理しています…' : sent ? 'ログイン' : '確認コードを送る'}
        </button>
        {sent && (
          <div className="action-buttons">
            <button type="button" className="text-button" onClick={() => void submit(false)}>
              再送する
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSent(false);
                setCode('');
                setError('');
              }}
            >
              メールアドレスを変える
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

export function AccountEntry({
  options,
  identity,
  onChange,
  initialError,
}: {
  options: AuthOptions;
  identity: IdentitySession | null;
  onChange: () => void;
  initialError: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function run(register: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(register ? '/auth/register' : '/auth/logout', {
        body: {},
      });
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <header className="header shell request-link-header">
        <a className="wordmark" href="/">
          Favor
        </a>
      </header>
      <main className="shell account-layout">
        <section className="account-panel" aria-label={identity ? 'サービスへの登録' : 'ログイン'}>
          <h1>{identity ? '登録内容の確認' : 'ログイン'}</h1>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {identity ? (
            <>
              <div className="registration-identity">
                <strong>{identity.account.name}</strong>
                <span>@{identity.account.handle}</span>
                <button className="text-button" disabled={busy} onClick={() => void run(false)}>
                  別のアカウントを使う
                </button>
              </div>
              <p className="hint">依頼相手にはXの表示名が表示されます</p>
              <button className="primary" disabled={busy} onClick={() => void run(true)}>
                {busy ? '登録しています…' : '登録する'}
                <Arrow />
              </button>
            </>
          ) : options.emailLogin ? (
            <>
              <EmailLoginForm onChange={onChange} />
              {options.xLogin && <XLoginButton />}
            </>
          ) : (
            <>
              {options.xLogin ? (
                <XLoginButton />
              ) : (
                <p className="inline-error" role="status">
                  現在、ログインを利用できません。時間をおいてお試しください。
                </p>
              )}
            </>
          )}
          <p className="hint">
            <Link href="/works">公開された作品を見る</Link>
          </p>
        </section>
      </main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </>
  );
}
