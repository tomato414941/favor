import { SignIn } from '@clerk/react-router';
import { useEffect } from 'react';
import { Link, useFetcher } from 'react-router';
import { useSite } from '../root';
import type { ActionFailure } from './ui';

export const afterLoginKey = 'favor.after-login';

/** Local sign-in by address, available only when the server runs in demo mode. */
function DemoLoginForm({ next, stay = false }: { next?: string; stay?: boolean }) {
  const fetcher = useFetcher<ActionFailure>();
  const busy = fetcher.state !== 'idle';
  return (
    <fetcher.Form
      className="email-login"
      aria-label="メールでログイン"
      method="post"
      action="/login"
    >
      {next && <input type="hidden" name="next" value={next} />}
      {stay && <input type="hidden" name="stay" value="1" />}
      <div className="field">
        <label htmlFor="login-email">メールアドレス</label>
        <input
          id="login-email"
          className="text-input"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          disabled={busy}
        />
      </div>
      {fetcher.data?.error && (
        <p className="inline-error" role="alert">
          {fetcher.data.error.message}
        </p>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? '処理しています…' : 'ログイン'}
      </button>
    </fetcher.Form>
  );
}

/**
 * The sign-in for the configured mode. Clerk owns its flow and returns to `next`;
 * with `inline`, the current page is remembered and shown again afterwards.
 */
export function SignInPanel({ next, inline = false }: { next?: string; inline?: boolean }) {
  const { mode } = useSite();
  useEffect(() => {
    if (!inline || mode !== 'clerk') return;
    try {
      sessionStorage.setItem(afterLoginKey, window.location.pathname + window.location.hash);
    } catch {
      /* Returning to the page is a convenience. */
    }
  }, [inline, mode]);
  if (mode === 'clerk') {
    // Clerk routes inside the fragment, so a private link page sends people to the sign-in page.
    if (inline)
      return (
        <Link className="primary" to="/login">
          ログインへ
        </Link>
      );
    const target = next ?? '/login';
    return (
      <SignIn routing="hash" fallbackRedirectUrl={target} signUpFallbackRedirectUrl={target} />
    );
  }
  return <DemoLoginForm {...(next ? { next } : {})} stay={inline} />;
}
