import { useEffect } from 'react';
import { data, redirect, useNavigate } from 'react-router';
import type { Route } from './+types/login';
import { afterLoginKey, SignInPanel } from '../components/Auth';
import { SiteHeader } from '../components/Header';
import { clientAction } from '../components/retry';
import { DemoBanner, Footer } from '../components/ui';
import { favorOf } from '../server/context';
import { attempt, demoToken, field, ownPath, sessionCookie, whoami } from '../server/session';

export { clientAction };

export async function loader(args: Route.LoaderArgs) {
  const next = ownPath(args.url.searchParams.get('next'));
  const signedIn = (await whoami(args)) !== null;
  if (signedIn && next) throw redirect(next);
  return { signedIn, next };
}

/** Demo sign-in by address. The person returns to `next`, or stays where they were. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const form = await args.request.formData();
  return attempt(async () => {
    favor.auth.logout(await demoToken(favor, args.request));
    const token = favor.auth.demoLoginEmail(field(form, 'email'));
    const headers = { 'Set-Cookie': await sessionCookie(favor).serialize(token) };
    const next = ownPath(field(form, 'next'));
    if (field(form, 'stay') !== '1') throw redirect(next ?? '/login', { headers });
    return data({ ok: true }, { headers });
  });
}

export default function Login({ loaderData: { signedIn, next } }: Route.ComponentProps) {
  const navigate = useNavigate();
  // Signed in without a destination: return to the page that asked for sign-in, else the sent list.
  useEffect(() => {
    if (!signedIn) return;
    let target = '/me/sent';
    try {
      const saved = sessionStorage.getItem(afterLoginKey);
      sessionStorage.removeItem(afterLoginKey);
      if (saved && /^\/(me(\/|$)|link#)/.test(saved)) target = saved;
    } catch {
      /* Fall back to the sent list. */
    }
    void navigate(target, { replace: true });
  }, [signedIn]);
  return (
    <>
      <DemoBanner />
      <SiteHeader identity={null} active={null} />
      <main className="shell account-layout">
        <section className="account-panel" aria-label="ログイン">
          <h1>ログイン</h1>
          {signedIn ? (
            <p role="status">ページを開いています…</p>
          ) : (
            <SignInPanel {...(next ? { next } : {})} />
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
