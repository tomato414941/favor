import { useCallback, useEffect, useState } from 'react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { AccountEntry, restoreXReturn } from './Auth';
import { RequestLinkLanding } from './RequestLinks';
import { Workspace } from './Workspace';

const initialLocation = restoreXReturn();

export function App() {
  const [hash, setHash] = useState(initialLocation.hash);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const changed = useCallback(() => {
    setReady(false);
    setAttempt((value) => value + 1);
  }, []);
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
  }, [attempt, hash]);
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const route = new URLSearchParams(hash.slice(1));
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
  if (route.has('link'))
    return (
      <RequestLinkLanding
        key={hash}
        token={route.get('link') ?? ''}
        options={options}
        initialError={initialLocation.error}
      />
    );
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
  return (
    <Workspace
      key={`${attempt}:${route.get('request') ?? 'workspace'}`}
      initialRequestId={route.get('request')}
      options={options}
      email={identity?.email}
      onSessionChange={changed}
    />
  );
}
