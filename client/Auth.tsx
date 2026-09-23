import { useRef, useState, type FormEvent } from 'react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { Arrow } from './ui';

const returnKey = 'commission.x-return';
const validReturn = (hash: string) =>
  /^(?:#link=[A-Za-z0-9_-]{43}|#request=[A-Za-z0-9_-]{1,100})$/.test(hash) ? hash : '';

export async function beginXLogin(returnTo = window.location.hash) {
  try {
    // Check storage before leaving. Private link tokens never enter the OAuth state or a server URL.
    sessionStorage.setItem(
      returnKey,
      JSON.stringify({ hash: validReturn(returnTo), at: Date.now() }),
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
        hash: validReturn(returnTo),
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

export function restoreXReturn(): { hash: string; error: string } {
  const current = new URLSearchParams(window.location.hash.slice(1));
  const outcome = current.get('auth');
  if (!outcome) return { hash: window.location.hash, error: '' };
  let hash = '';
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey) ?? 'null');
    if (saved && saved.state === current.get('flow')) {
      sessionStorage.removeItem(returnKey);
      if (
        typeof saved.at === 'number' &&
        Date.now() - saved.at < 900_000 &&
        typeof saved.hash === 'string'
      )
        hash = validReturn(saved.hash);
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
  window.history.replaceState(null, '', `/${hash}`);
  return { hash, error };
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

export function LocalAccountForm({ onChange }: { onChange: () => void | Promise<void> }) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const register = mode === 'register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/auth/local/${mode}`, {
        body: { email, password },
      });
      setPassword('');
      await onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="local-account-form"
      onSubmit={(event) => void submit(event)}
      aria-label={register ? 'アカウント登録' : 'ログイン'}
    >
      <div className="account-tabs">
        <button
          type="button"
          aria-pressed={register}
          disabled={busy}
          onClick={() => {
            setMode('register');
            setPassword('');
            setError('');
          }}
        >
          新規登録
        </button>
        <button
          type="button"
          aria-pressed={!register}
          disabled={busy}
          onClick={() => {
            setMode('login');
            setPassword('');
            setError('');
          }}
        >
          ログイン
        </button>
      </div>
      <fieldset disabled={busy} className="account-fields">
        <div className="field">
          <label htmlFor="account-email">メールアドレス</label>
          <input
            id="account-email"
            className="text-input"
            type="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="account-password">パスワード</label>
          <input
            id="account-password"
            className="text-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={register ? 'new-password' : 'current-password'}
            minLength={12}
            maxLength={1024}
            required
          />
          {register && <p className="hint">12文字以上</p>}
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? '処理しています…' : register ? '登録する' : 'ログインする'}
        </button>
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
          commission
        </a>
      </header>
      <main className="shell account-layout">
        <section className="account-panel" aria-label={identity ? 'サービスへの登録' : 'ログイン'}>
          <h1>{identity ? '登録内容の確認' : options.localLogin ? 'アカウント' : 'ログイン'}</h1>
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
          ) : options.localLogin ? (
            <>
              <LocalAccountForm onChange={onChange} />
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
        </section>
      </main>
      <footer className="footer shell">
        <span className="footer-brand">commission</span>
      </footer>
    </>
  );
}
