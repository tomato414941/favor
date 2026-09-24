import { useCallback, useEffect, useState } from 'react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { AccountEntry, restoreXReturn } from './Auth';
import { Home } from './Home';
import { WorkPage, WorksList } from './Works';
import { RequestLinkLanding } from './RequestLinks';
import { Workspace, type Page } from './Workspace';
import { Link } from './ui';

const initialLocation = restoreXReturn();
const location = () => `${window.location.pathname}${window.location.hash}`;

type Route =
  | { kind: 'home' }
  | { kind: 'works' }
  | { kind: 'work'; id: string }
  | { kind: 'link'; token: string }
  | { kind: 'workspace'; page: Page; requestId: string | null }
  | { kind: 'missing' };

function parse(value: string): Route {
  const url = new URL(value, window.location.origin);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { kind: 'home' };
  if (path === '/works') return { kind: 'works' };
  const work = /^\/works\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (work) return { kind: 'work', id: work[1]! };
  if (path === '/link') return { kind: 'link', token: url.hash.slice(1) };
  if (path === '/new') return { kind: 'workspace', page: 'new', requestId: null };
  if (path === '/sent') return { kind: 'workspace', page: 'sent', requestId: null };
  if (path === '/received') return { kind: 'workspace', page: 'received', requestId: null };
  const request = /^\/requests\/([A-Za-z0-9-]{1,100})$/.exec(path);
  if (request) return { kind: 'workspace', page: 'request', requestId: request[1]! };
  return { kind: 'missing' };
}

export function App() {
  const [current, setCurrent] = useState(initialLocation.location);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const changed = useCallback(() => {
    setReady(false);
    setAttempt((value) => value + 1);
  }, []);
  const route = parse(current);
  const publicPage = route.kind === 'works' || route.kind === 'work' || route.kind === 'link';
  useEffect(() => {
    let active = true;
    setReady(false);
    void Promise.all([
      api<AuthOptions>('/auth/options'),
      api<IdentitySession | null>('/auth/identity'),
    ])
      .then(([next, account]) => {
        if (!active) return;
        setOptions(next);
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
  }, [attempt, publicPage, route.kind === 'link' ? route.token : '']);
  useEffect(() => {
    const change = () => setCurrent(location());
    window.addEventListener('popstate', change);
    window.addEventListener('hashchange', change);
    return () => {
      window.removeEventListener('popstate', change);
      window.removeEventListener('hashchange', change);
    };
  }, []);
  if (route.kind === 'works') return <WorksList />;
  if (route.kind === 'work') return <WorkPage key={route.id} id={route.id} />;
  if (route.kind === 'missing')
    return (
      <main className="shell works-page">
        <h1>ページが見つかりません</h1>
        <p>
          <Link href="/">ホームへ</Link>
        </p>
      </main>
    );
  if (!options || !ready)
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
  if (route.kind === 'link')
    return (
      <RequestLinkLanding
        key={route.token}
        token={route.token}
        options={options}
        initialError={initialLocation.error}
      />
    );
  if (route.kind === 'home' && options.mode !== 'demo' && !identity && !initialLocation.error)
    return <Home />;
  if (options.mode !== 'demo' && !identity?.registered)
    return (
      <AccountEntry
        key={identity?.account.subject ?? 'login'}
        options={options}
        identity={identity}
        onChange={changed}
        initialError={initialLocation.error}
      />
    );
  const page: Page = route.kind === 'workspace' ? route.page : 'new';
  const requestId = route.kind === 'workspace' ? route.requestId : null;
  return (
    <Workspace
      key={String(attempt)}
      page={page}
      requestId={requestId}
      options={options}
      email={identity?.email}
      onSessionChange={changed}
    />
  );
}
