import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { jaJP } from '@clerk/localizations';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { AccountEntry } from './Auth';
import { Home } from './Home';
import { WorkPage, WorksList } from './Works';
import { RequestLinkLanding } from './RequestLinks';
import { Workspace, type Page } from './Workspace';
import { Link } from './ui';

const location = () => `${window.location.pathname}${window.location.hash}`;
const afterLoginKey = 'favor.after-login';

type Route =
  | { kind: 'home' }
  | { kind: 'login' }
  | { kind: 'works' }
  | { kind: 'work'; id: string }
  | { kind: 'link'; token: string }
  | { kind: 'me'; page: Page; requestId: string | null }
  | { kind: 'missing' };

function parse(value: string): Route {
  const url = new URL(value, window.location.origin);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { kind: 'home' };
  if (path === '/login') return { kind: 'login' };
  if (path === '/works') return { kind: 'works' };
  const work = /^\/works\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (work) return { kind: 'work', id: work[1]! };
  if (path === '/link') return { kind: 'link', token: url.hash.slice(1) };
  if (path === '/me' || path === '/me/sent') return { kind: 'me', page: 'sent', requestId: null };
  if (path === '/me/new') return { kind: 'me', page: 'new', requestId: null };
  if (path === '/me/received') return { kind: 'me', page: 'received', requestId: null };
  if (path === '/me/works') return { kind: 'me', page: 'works', requestId: null };
  const request = /^\/me\/requests\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (request) return { kind: 'me', page: 'request', requestId: request[1]! };
  const link = /^\/me\/links\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (link) return { kind: 'me', page: 'link', requestId: link[1]! };
  return { kind: 'missing' };
}

function replace(path: string) {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Japanese strings, with Favor's own wording where Clerk would show the application name. */
const localization = {
  ...jaJP,
  signIn: {
    ...jaJP.signIn,
    start: {
      ...jaJP.signIn?.start,
      title: 'Favor にログイン',
      subtitle: 'メールアドレスで続けてください',
    },
  },
  signUp: {
    ...jaJP.signUp,
    start: {
      ...jaJP.signUp?.start,
      title: 'Favor に登録',
      subtitle: 'メールアドレスで続けてください',
    },
  },
};

/** Re-reads who is signed in whenever Clerk's own state changes. */
function ClerkSync({ onChange }: { onChange: () => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  useEffect(() => {
    if (isLoaded) onChange();
  }, [isLoaded, isSignedIn, onChange]);
  return null;
}

function Providers({
  options,
  children,
  onChange,
}: {
  options: AuthOptions | null;
  children: ReactNode;
  onChange: () => void;
}) {
  if (options?.mode !== 'clerk' || !options.publishableKey) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={options.publishableKey} localization={localization}>
      <ClerkSync onChange={onChange} />
      {children}
    </ClerkProvider>
  );
}

export function App() {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [clerkTick, setClerkTick] = useState(0);
  const clerkChanged = useCallback(() => setClerkTick((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    api<AuthOptions>('/auth/options').then(
      (next) => active && setOptions(next),
      (cause: unknown) =>
        active && setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。'),
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  if (!options)
    return (
      <main className="shell">
        <div className="loading" role="status">
          {error ? '接続をお確かめください。' : 'ページを開いています…'}
        </div>
        {error && (
          <p className="message error" role="alert">
            {error} <button onClick={() => setAttempt((value) => value + 1)}>再読み込み</button>
          </p>
        )}
      </main>
    );
  return (
    <Providers options={options} onChange={clerkChanged}>
      <Pages options={options} clerkTick={clerkTick} />
    </Providers>
  );
}

function Pages({ options, clerkTick }: { options: AuthOptions; clerkTick: number }) {
  const [current, setCurrent] = useState(location());
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const changed = useCallback(() => {
    setReady(false);
    setAttempt((value) => value + 1);
  }, []);
  const route = parse(current);
  useEffect(() => {
    let active = true;
    setReady(false);
    void api<IdentitySession | null>('/auth/identity')
      .then((account) => {
        if (!active) return;
        setIdentity(account);
        setReady(true);
        setError('');
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。');
      });
    return () => {
      active = false;
    };
  }, [attempt, clerkTick, route.kind, route.kind === 'link' ? route.token : '']);
  useEffect(() => {
    const change = () => setCurrent(location());
    window.addEventListener('popstate', change);
    window.addEventListener('hashchange', change);
    return () => {
      window.removeEventListener('popstate', change);
      window.removeEventListener('hashchange', change);
    };
  }, []);
  const signedIn = identity?.registered === true;
  // Own pages need a signed-in person; the login page sends them back afterwards.
  useEffect(() => {
    if (!ready) return;
    if (route.kind === 'me' && !signedIn) {
      try {
        if (!sessionStorage.getItem(afterLoginKey)) sessionStorage.setItem(afterLoginKey, current);
      } catch {
        /* Returning to the page is a convenience. */
      }
      replace('/login');
    } else if (route.kind === 'login' && signedIn) {
      let next = '/me/sent';
      try {
        const saved = sessionStorage.getItem(afterLoginKey);
        sessionStorage.removeItem(afterLoginKey);
        if (saved && /^\/me(\/|$)/.test(saved)) next = saved;
      } catch {
        /* Fall back to the sent list. */
      }
      replace(next);
    } else if (window.location.pathname === '/me') replace('/me/sent');
  }, [ready, route.kind, signedIn, current]);
  const logout = useCallback(async () => {
    const clerk = (window as unknown as { Clerk?: { signOut(): Promise<void> } }).Clerk;
    if (options.mode === 'clerk' && clerk) await clerk.signOut();
    else await api('/auth/logout', { body: {} });
    changed();
  }, [changed, options.mode]);
  if (route.kind === 'missing')
    return (
      <main className="shell works-page">
        <h1>ページが見つかりません</h1>
        <p>
          <Link href="/">ホームへ</Link>
        </p>
      </main>
    );
  if (!ready)
    return (
      <main className="shell">
        <div className="loading" role="status">
          {error ? '接続をお確かめください。' : 'ページを開いています…'}
        </div>
        {error && (
          <p className="message error" role="alert">
            {error} <button onClick={changed}>再読み込み</button>
          </p>
        )}
      </main>
    );
  const shown = signedIn ? identity : null;
  if (route.kind === 'home') return <Home identity={shown} onLogout={logout} />;
  if (route.kind === 'works') return <WorksList identity={shown} onLogout={logout} />;
  if (route.kind === 'work')
    return <WorkPage key={route.id} id={route.id} identity={shown} onLogout={logout} />;
  if (route.kind === 'link')
    return <RequestLinkLanding key={route.token} token={route.token} options={options} />;
  if (route.kind === 'login' || !signedIn)
    return (
      <AccountEntry
        key={identity?.account.subject ?? 'login'}
        options={options}
        onChange={changed}
      />
    );
  return (
    <Workspace
      key={String(attempt)}
      page={route.page}
      requestId={route.requestId}
      identity={identity}
      onSessionChange={changed}
    />
  );
}
