import { useRef, useState, type FormEvent } from 'react';
import { SignIn } from '@clerk/clerk-react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { SiteHeader } from './Header';

/** Local sign-in by address, available only when the server runs in demo mode. */
function DemoLoginForm({ onChange }: { onChange: () => void | Promise<void> }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await api<IdentitySession>('/demo/login', { body: { email } });
      await onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ログインできませんでした。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="email-login"
      aria-label="メールでログイン"
      onSubmit={(event) => void submit(event)}
    >
      <div className="field">
        <label htmlFor="login-email">メールアドレス</label>
        <input
          id="login-email"
          className="text-input"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
          autoComplete="email"
          disabled={busy}
        />
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '処理しています…' : 'ログイン'}
      </button>
    </form>
  );
}

/** The sign-in for the configured mode. Clerk owns the flow; the app only learns the outcome. */
export function SignInPanel({
  options,
  onChange,
}: {
  options: AuthOptions;
  onChange: () => void | Promise<void>;
}) {
  if (options.mode === 'clerk')
    return (
      <SignIn routing="hash" fallbackRedirectUrl="/login" signUpFallbackRedirectUrl="/login" />
    );
  return <DemoLoginForm onChange={onChange} />;
}

export function AccountEntry({
  options,
  onChange,
}: {
  options: AuthOptions;
  onChange: () => void;
}) {
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <SiteHeader identity={null} active={null} />
      <main className="shell account-layout">
        <section className="account-panel" aria-label="ログイン">
          {options.mode === 'demo' && <h1>ログイン</h1>}
          <SignInPanel options={options} onChange={onChange} />
        </section>
      </main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </>
  );
}
