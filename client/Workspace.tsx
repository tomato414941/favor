import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthOptions, RequestView, SessionView } from '../src/shared';
import { api, ApiError } from './api';
import { RequestLinks } from './RequestLinks';
import type { RequestFormSettings } from './RequestForm';
import { RequestDetail, RequestStatus, type RequestAction } from './RequestDetail';
import { yen } from './format';

type Page = 'compose' | 'requests';

export function Workspace({
  initialRequestId,
  options,
  email,
  onSessionChange,
}: {
  initialRequestId: string | null;
  options: AuthOptions;
  email?: string;
  onSessionChange: () => void;
}) {
  const [settings, setSettings] = useState<RequestFormSettings | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [page, setPage] = useState<Page>(initialRequestId ? 'requests' : 'compose');
  const [selectedId, setSelectedId] = useState<string | null>(initialRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const lock = useRef(false);
  const ticket = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++ticket.current;
    const [nextSession, data] = await Promise.all([
      api<SessionView>('/session'),
      api<{ requests: RequestView[] }>('/requests'),
    ]);
    if (current !== ticket.current) return;
    setSession(nextSession);
    setRequests(data.requests);
    setSelectedId((id) =>
      data.requests.some((request) => request.id === id) ? id : (data.requests[0]?.id ?? null),
    );
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
  const navigate = (next: Page) => {
    setPage(next);
    setError('');
    setNotice('');
  };
  const selected = requests.find((request) => request.id === selectedId);
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <header className="header shell">
        <button
          className="wordmark"
          onClick={() => navigate('compose')}
          aria-label="commission ホーム"
        >
          commission
        </button>
        {session && (
          <>
            <nav aria-label="メインナビゲーション">
              <button
                aria-current={page === 'compose' ? 'page' : undefined}
                onClick={() => navigate('compose')}
              >
                依頼を作る
              </button>
              <button
                aria-current={page === 'requests' ? 'page' : undefined}
                onClick={() => navigate('requests')}
              >
                依頼一覧
              </button>
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
            {page === 'requests' && (
              <div className="section-heading workspace-heading">
                <h1>依頼一覧</h1>
                <button className="quiet-button" onClick={() => navigate('compose')}>
                  依頼を作る
                </button>
              </div>
            )}
            <RequestLinks
              settings={settings}
              composing={page === 'compose'}
              onCreated={() => navigate('requests')}
            />
            {page === 'requests' && (
              <section className="requests-section">
                <div className="section-heading">
                  <h2>制作・納品</h2>
                  <span className="total">{requests.length} 件</span>
                </div>
                {requests.length ? (
                  <div className="requests-layout">
                    <div className="request-list" aria-label="依頼を選択">
                      {requests.map((request) => (
                        <button
                          key={request.id}
                          className={`request-item ${request.id === selectedId ? 'selected' : ''}`}
                          aria-pressed={request.id === selectedId}
                          onClick={() => {
                            setSelectedId(request.id);
                            setError('');
                            setNotice('');
                          }}
                        >
                          <span className="request-item-top">
                            <RequestStatus request={request} />
                            <span className="request-direction">
                              {request.viewerRole === 'creator' ? '受けた依頼' : '送った依頼'}
                            </span>
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
                ) : (
                  <div className="empty-state">
                    <h2>制作中・納品済みの依頼はありません</h2>
                    <p>受諾した依頼は、ここで制作・納品の状況を確認できます。</p>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
      <footer className="footer shell">
        <span className="footer-brand">commission</span>
      </footer>
    </>
  );
}
