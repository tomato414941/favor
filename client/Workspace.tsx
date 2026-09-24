import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthOptions, RequestLinkView, RequestView, SessionView } from '../src/shared';
import { api, ApiError } from './api';
import { RequestLinks } from './RequestLinks';
import type { RequestFormSettings } from './RequestForm';
import { RequestDetail, RequestStatus, type RequestAction } from './RequestDetail';
import { yen } from './format';
import { Link, navigate } from './ui';

export type Page = 'new' | 'sent' | 'received' | 'request';

export function Workspace({
  page,
  requestId,
  options,
  email,
  onSessionChange,
}: {
  page: Page;
  requestId: string | null;
  options: AuthOptions;
  email?: string;
  onSessionChange: () => void;
}) {
  const [settings, setSettings] = useState<RequestFormSettings | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [links, setLinks] = useState<RequestLinkView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const lock = useRef(false);
  const ticket = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++ticket.current;
    const [nextSession, data, sent] = await Promise.all([
      api<SessionView>('/session'),
      api<{ requests: RequestView[] }>('/requests'),
      api<{ links: RequestLinkView[] }>('/links'),
    ]);
    if (current !== ticket.current) return;
    setSession(nextSession);
    setRequests(data.requests);
    setLinks(sent.links);
  }, []);
  useEffect(() => {
    let active = true;
    const boot = async () => {
      setError('');
      const [nextSettings, existing] = await Promise.all([
        api<RequestFormSettings>('/request-settings'),
        api<SessionView | null>(options.mode === 'demo' ? '/demo/session' : '/session'),
      ]);
      if (!existing && options.mode === 'demo')
        await api('/demo/session', { body: { role: 'client' } });
      if (!active) return;
      setSettings(nextSettings);
      await refresh();
    };
    void boot().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。');
    });
    return () => {
      active = false;
      ticket.current++;
    };
  }, [attempt, options.mode, refresh]);
  useEffect(() => {
    if (!session) return;
    const poll = () => {
      if (document.hidden || lock.current) return;
      void refresh().catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 401) onSessionChange();
        else setError('最新の状態を確認できません。接続を確認して、再読み込みしてください。');
      });
    };
    const timer = window.setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [Boolean(session), refresh, onSessionChange]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    ticket.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function act(request: RequestView, action: RequestAction) {
    await run(async () => {
      const path = `/requests/${request.id}/${action.type}`;
      const body = action.type === 'deliver' ? { files: action.files } : {};
      const payload = JSON.stringify(body);
      let operation = keys.current.get(path);
      if (!operation || operation.payload !== payload) {
        operation = { payload, key: crypto.randomUUID() };
        keys.current.set(path, operation);
      }
      const updated = await api<RequestView>(path, { body, key: operation.key });
      keys.current.delete(path);
      setRequests((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(
        action.type === 'deliver' ? 'ファイルを納品しました。' : '依頼をキャンセルしました。',
      );
      await refresh();
    });
  }
  const changeLink = (link: RequestLinkView) => {
    ticket.current++;
    setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
  };
  const go = (path: string) => {
    setError('');
    setNotice('');
    navigate(path);
  };
  const pendingLinks = links.filter((link) => link.state !== 'accepted');
  const sentRequests = requests.filter((request) => request.viewerRole === 'client');
  const receivedRequests = requests.filter((request) => request.viewerRole === 'creator');
  const current = requests.find((request) => request.id === requestId);
  const side: 'sent' | 'received' | null =
    page === 'sent' || page === 'received'
      ? page
      : page === 'request'
        ? current?.viewerRole === 'creator'
          ? 'received'
          : 'sent'
        : null;
  const visible = side === 'received' ? receivedRequests : sentRequests;
  const selected = current ?? visible[0];
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <header className="header shell">
        <Link className="wordmark" href="/" aria-label="Favor ホーム">
          Favor
        </Link>
        {session && (
          <>
            <nav aria-label="メインナビゲーション">
              <Link href="/new" aria-current={page === 'new' ? 'page' : undefined}>
                依頼を作る
              </Link>
              <Link href="/sent" aria-current={side === 'sent' ? 'page' : undefined}>
                送った依頼
                <span className="count">{pendingLinks.length + sentRequests.length}</span>
              </Link>
              <Link href="/received" aria-current={side === 'received' ? 'page' : undefined}>
                受けた依頼
                <span className="count">{receivedRequests.length}</span>
              </Link>
              <Link href="/works">作品</Link>
            </nav>
            <div className="account-menu">
              <span title={email ?? session.name}>{email ?? session.name}</span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/auth/logout', { body: {} });
                    onSessionChange();
                  })
                }
              >
                ログアウト
              </button>
            </div>
          </>
        )}
      </header>
      <main className="shell">
        {error && (
          <div className="message error" role="alert">
            {error}{' '}
            <button
              disabled={busy}
              onClick={() => (session ? void run(refresh) : setAttempt((value) => value + 1))}
            >
              再読み込み
            </button>
          </div>
        )}
        {notice && (
          <div className="message success" role="status">
            {notice}
          </div>
        )}
        {!settings || !session ? (
          <div className="loading" role="status">
            {error ? '接続をお確かめください。' : 'ページを開いています…'}
          </div>
        ) : (
          <>
            <div className={page === 'new' ? undefined : 'list-panel'}>
              <RequestLinks
                settings={settings}
                mode={page === 'new' ? 'compose' : side === 'sent' ? 'list' : 'hidden'}
                links={pendingLinks}
                busy={busy}
                run={run}
                notify={setNotice}
                onChange={changeLink}
                onCreated={() => navigate('/sent')}
              />
              {page !== 'new' &&
                (visible.length ? (
                  <div className="requests-layout">
                    <div className="request-list" aria-label="依頼を選択">
                      {visible.map((request) => (
                        <button
                          key={request.id}
                          className={`request-item ${request.id === selected?.id ? 'selected' : ''}`}
                          aria-pressed={request.id === selected?.id}
                          onClick={() => go(`/requests/${request.id}`)}
                        >
                          <span className="request-item-top">
                            <RequestStatus request={request} />
                          </span>
                          <span className="request-excerpt">{request.brief}</span>
                          <span className="request-item-bottom">
                            <span>
                              {request.viewerRole === 'creator'
                                ? request.clientName
                                : request.creatorName}
                            </span>
                            <span>{yen(request.amount)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {selected && (
                      <RequestDetail
                        key={`${selected.viewerRole}:${selected.id}`}
                        request={selected}
                        role={selected.viewerRole}
                        limits={settings.limits}
                        busy={busy}
                        act={act}
                      />
                    )}
                  </div>
                ) : side === 'sent' ? (
                  !pendingLinks.length && (
                    <div className="empty-state">
                      <h2>送った依頼はありません</h2>
                      <p>リンクを作って相手に共有すると、受諾から納品までをここで確認できます。</p>
                      <Link className="quiet-button" href="/new">
                        依頼を作る
                      </Link>
                    </div>
                  )
                ) : (
                  <div className="empty-state">
                    <h2>受けた依頼はありません</h2>
                    <p>依頼リンクを受諾すると、ここで制作・納品を進められます。</p>
                  </div>
                ))}
            </div>
          </>
        )}
      </main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </>
  );
}
