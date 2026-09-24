import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdentitySession, RequestLinkView, RequestView, SessionView } from '../src/shared';
import { api, ApiError } from './api';
import { RequestLinks, LinkStatus } from './RequestLinks';
import type { RequestFormSettings } from './RequestForm';
import { RequestDetail, RequestStatus, type RequestAction } from './RequestDetail';
import { yen } from './format';
import { Link, navigate } from './ui';
import { SiteHeader } from './Header';
import { WorkImages } from './Works';
import { visibilityLabels } from './format';

export type Page = 'new' | 'sent' | 'received' | 'works' | 'request' | 'link';

export function Workspace({
  page,
  requestId,
  identity,
  onSessionChange,
}: {
  page: Page;
  requestId: string | null;
  identity: IdentitySession | null;
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
      const nextSettings = await api<RequestFormSettings>('/request-settings');
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
  }, [attempt, refresh]);
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
      setNotice(action.type === 'deliver' ? '作品を渡しました。' : '依頼を中止しました。');
      await refresh();
    });
  }
  const changeLink = (link: RequestLinkView) => {
    ticket.current++;
    setLinks((current) => [link, ...current.filter((item) => item.id !== link.id)]);
  };
  const pendingLinks = links.filter((link) => link.state !== 'accepted');
  const sentRequests = requests.filter((request) => request.viewerRole === 'client');
  const receivedRequests = requests.filter((request) => request.viewerRole === 'creator');
  const current = requests.find((request) => request.id === requestId);
  const side: 'sent' | 'received' | null =
    page === 'sent' || page === 'link'
      ? 'sent'
      : page === 'received'
        ? 'received'
        : page === 'request'
          ? current?.viewerRole === 'creator'
            ? 'received'
            : 'sent'
          : null;
  const visible = side === 'received' ? receivedRequests : sentRequests;
  const mine = receivedRequests.filter((request) => request.state === 'delivered');
  const rows = [
    ...visible.map((request) => ({
      id: request.id,
      createdAt: request.createdAt,
      href: `/me/requests/${request.id}`,
      brief: request.brief,
      person: request.viewerRole === 'creator' ? request.clientName : request.creatorName,
      amount: request.amount,
      status: <RequestStatus request={request} />,
    })),
    ...(side === 'sent'
      ? pendingLinks.map((link) => ({
          id: link.id,
          createdAt: link.createdAt,
          href: `/me/links/${link.id}`,
          brief: link.brief,
          person: link.recipientEmail ?? 'リンクで共有',
          amount: link.amount,
          status: <LinkStatus link={link} />,
        }))
      : []),
  ].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="workspace">
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <SiteHeader
        identity={
          identity ??
          (session
            ? {
                account: { provider: 'demo', subject: '', handle: '', name: session.name },
                registered: true,
              }
            : null)
        }
        active={page === 'new' ? 'new' : page === 'works' ? 'mine' : side}
        counts={{
          sent: pendingLinks.length + sentRequests.length,
          received: receivedRequests.length,
        }}
        label={identity?.email ?? session?.name}
        busy={busy}
        onLogout={() =>
          void run(async () => {
            await api('/auth/logout', { body: {} });
            onSessionChange();
          })
        }
      />
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
            <RequestLinks
              settings={settings}
              mode={page === 'new' ? 'compose' : page === 'link' ? 'detail' : 'hidden'}
              linkId={requestId}
              links={links}
              busy={busy}
              run={run}
              notify={setNotice}
              onChange={changeLink}
              onCreated={(id) => navigate(`/me/links/${id}`)}
            />
            {page === 'works' && (
              <div className="list-panel">
                <h1 className="page-title">自分の作品</h1>
                {mine.length ? (
                  <ul className="works-list">
                    {mine.map((request) => (
                      <li key={request.id}>
                        <Link href={`/me/requests/${request.id}`}>
                          <WorkImages work={request} />
                          <span className="work-parties">
                            {visibilityLabels[request.visibility]} · {request.clientName}から
                          </span>
                          <span className="work-brief">{request.brief}</span>
                        </Link>
                        {request.visibility !== 'hidden' && (
                          <p className="hint">
                            <Link href={`/works/${request.id}`}>作品ページを見る</Link>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty-state">作品はまだありません</p>
                )}
              </div>
            )}
            {(page === 'sent' || page === 'received') && (
              <div className="list-panel">
                <h1 className="page-title">{page === 'sent' ? '送った依頼' : '受けた依頼'}</h1>
                {rows.length ? (
                  <ul
                    className="request-list"
                    aria-label={page === 'sent' ? '送った依頼' : '受けた依頼'}
                  >
                    {rows.map((row) => (
                      <li key={row.id}>
                        <Link className="request-row" href={row.href}>
                          <span className="request-excerpt">{row.brief}</span>
                          <span className="request-person">{row.person}</span>
                          <span className="request-amount">{yen(row.amount)}</span>
                          {row.status}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty-state">
                    <p>{page === 'sent' ? '送った依頼はありません' : '受けた依頼はありません'}</p>
                    {page === 'sent' && (
                      <Link className="quiet-button" href="/me/new">
                        お願いを書く
                      </Link>
                    )}
                  </div>
                )}
              </div>
            )}
            {page === 'request' && (
              <div className="detail-page">
                <Link
                  className="back-link"
                  href={side === 'received' ? '/me/received' : '/me/sent'}
                >
                  {side === 'received' ? '受けた依頼へ' : '送った依頼へ'}
                </Link>
                {current ? (
                  <RequestDetail
                    key={current.id}
                    request={current}
                    role={current.viewerRole}
                    limits={settings.limits}
                    busy={busy}
                    act={act}
                  />
                ) : (
                  <p className="empty-state">依頼が見つかりません</p>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </div>
  );
}
