import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { paymentLabels, requestLabels, type AuthOptions, type IdentitySession, type RequestView, type Role, type SessionView, type UploadInput, type Visibility } from '../src/shared';
import { api, ApiError, encodeFile } from './api';
import { Arrow } from './ui';
import { InvitationLanding } from './Invitations';
import { RequestLinks, RequestLinkLanding } from './RequestLinks';
import type { RequestFormSettings } from './RequestForm';
import { AccountEntry, restoreXReturn } from './Auth';

interface Limits { brief: number; files: number; uploadBytes: number; maximumAmount: number }
type Page = 'compose' | 'requests';
const number = new Intl.NumberFormat('ja-JP');
const yen = (value: number) => `¥${number.format(value)}`;
const date = (value: number) => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
const visibilityLabels: Record<Visibility, string> = { public: '公開', anonymous: '匿名', hidden: '非表示' };
const reasons: Record<string, string> = {
  withdrawn: '依頼を取り消しました。', declined: '作り手が依頼を見送りました。',
  give_up: '作り手が制作を終了しました。', acceptance_expired: '承認期限または支払確保の期限を過ぎました。',
  delivery_expired: '納品期限を過ぎました。', payment_expired: '支払いの確認期限を過ぎました。',
};
function Status({ request }: { request: RequestView }) {
  return <span className={`status status-${request.state}`}><i />{requestLabels[request.state]}</span>;
}

const initialLocation = restoreXReturn();

export function App() {
  const [hash, setHash] = useState(initialLocation.hash);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const changed = useCallback(() => { setReady(false); setAttempt((value) => value + 1); }, []);
  useEffect(() => {
    let active = true;
    setReady(false);
    void Promise.all([api<AuthOptions>('/auth/options'), api<IdentitySession | null>('/auth/identity')]).then(([next, account]) => {
      if (!active) return;
      setOptions(next); setIdentity(account); setReady(true); setError('');
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。'); });
    return () => { active = false; };
  }, [attempt, hash]);
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const route = new URLSearchParams(hash.slice(1));
  if (!options || !ready) return <main className="shell"><div className="loading" role="status">{error ? '接続をお確かめください。' : 'ページを開いています…'}</div>{error && <p className="message error" role="alert">{error} <button onClick={changed}>再読み込み</button></p>}</main>;
  if (route.has('link')) return <RequestLinkLanding key={hash} token={route.get('link') ?? ''} options={options} initialError={initialLocation.error} />;
  if (route.has('invite')) return <InvitationLanding key={hash} token={route.get('invite') ?? ''} options={options} initialError={initialLocation.error} />;
  if (options.mode !== 'demo' && !identity?.registered) return <AccountEntry key={identity?.account.subject ?? 'login'} options={options} identity={identity} onChange={changed} initialError={initialLocation.error} />;
  return <Workspace key={`${attempt}:${route.get('request') ?? 'workspace'}`} initialRequestId={route.get('request')} options={options} onSessionChange={changed} />;
}

function Workspace({ initialRequestId, options, onSessionChange }: { initialRequestId: string | null; options: AuthOptions; onSessionChange: () => void }) {
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
    const [nextSession, data] = await Promise.all([api<SessionView>('/session'), api<{ requests: RequestView[] }>('/requests')]);
    if (current !== ticket.current) return;
    setSession(nextSession); setRequests(data.requests);
    setSelectedId((id) => data.requests.some((request) => request.id === id) ? id : data.requests[0]?.id ?? null);
  }, []);
  useEffect(() => {
    let active = true;
    const boot = async () => {
      setError('');
      const [nextSettings, existing] = await Promise.all([api<RequestFormSettings>('/request-settings'), api<SessionView | null>(options.mode === 'demo' ? '/demo/session' : '/session')]);
      if (!existing && options.mode === 'demo') await api('/demo/session', { role: 'client' });
      if (!active) return;
      setSettings(nextSettings);
      await refresh();
    };
    void boot().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'ページを開けませんでした。'); });
    return () => { active = false; ticket.current++; };
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
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [Boolean(session), refresh, onSessionChange]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; ticket.current++; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function act(request: RequestView, action: 'accept' | 'cancel', files?: UploadInput[]) {
    await run(async () => {
      const path = `/requests/${request.id}/${files ? 'deliver' : action}`;
      const body = files ? { files } : {};
      const payload = JSON.stringify(body);
      let operation = keys.current.get(path);
      if (!operation || operation.payload !== payload) { operation = { payload, key: crypto.randomUUID() }; keys.current.set(path, operation); }
      const updated = await api<RequestView>(path, body, operation.key);
      keys.current.delete(path);
      setRequests((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(files ? 'ファイルを納品しました。' : action === 'accept' ? '依頼を承認しました。' : '依頼をキャンセルしました。');
      await refresh();
    });
  }
  const navigate = (next: Page) => { setPage(next); setError(''); setNotice(''); };
  const selected = requests.find((request) => request.id === selectedId);
  return <>
    <div className="demo-banner"><span className="demo-mark">DEMO</span>決済は体験用 · 実際の請求は発生しません</div>
    <header className="header shell"><button className="wordmark" onClick={() => navigate('compose')} aria-label="commission ホーム">commission<span>↗</span></button>
      {session && <><nav aria-label="メインナビゲーション"><button aria-current={page === 'compose' ? 'page' : undefined} onClick={() => navigate('compose')}>依頼を作る</button><button aria-current={page === 'requests' ? 'page' : undefined} onClick={() => navigate('requests')}>依頼一覧</button></nav><div className="account-menu"><span>{session.name}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => { await api('/auth/logout', {}); onSessionChange(); })}>ログアウト</button></div></>}
    </header>
    <main className="shell">
      {error && <div className="message error" role="alert">{error} <button disabled={busy} onClick={() => session ? void run(refresh) : setAttempt((value) => value + 1)}>再読み込み</button></div>}
      {notice && <div className="message success" role="status">{notice}</div>}
      {!settings || !session ? <div className="loading" role="status">{error ? '接続をお確かめください。' : 'ページを開いています…'}</div> : <>
        {page === 'requests' && <div className="section-heading workspace-heading"><div><p className="eyebrow">YOUR COMMISSIONS</p><h1>あなたの依頼</h1></div><button className="quiet-button" onClick={() => navigate('compose')}>依頼を作る<Arrow /></button></div>}
        <RequestLinks settings={settings} composing={page === 'compose'} onCreated={() => navigate('requests')} />
        {page === 'requests' && <section className="requests-section"><div className="section-heading"><h2>制作・納品</h2><span className="total">{requests.length} 件</span></div>
          {requests.length ? <div className="requests-layout"><div className="request-list" aria-label="依頼を選択">{requests.map((request) => <button key={request.id} className={`request-item ${request.id === selectedId ? 'selected' : ''}`} aria-pressed={request.id === selectedId} onClick={() => { setSelectedId(request.id); setError(''); setNotice(''); }}><span className="request-item-top"><Status request={request} /><span className="request-direction">{request.viewerRole === 'creator' ? '受けた依頼' : '送った依頼'}</span></span><span className="request-excerpt">{request.brief}</span><span className="request-item-bottom"><span>{request.viewerRole === 'creator' ? request.clientName : request.creatorName}</span><span>{yen(request.amount ?? 0)}</span></span></button>)}</div>{selected && <RequestDetail key={`${selected.viewerRole}:${selected.id}`} request={selected} role={selected.viewerRole ?? session.role} limits={settings.limits} busy={busy} act={act} />}</div> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">c.</span><h2>これから、創作がはじまります</h2><p>受諾した依頼は、ここで制作・納品の状況を確認できます。</p></div>}
        </section>}
      </>}
    </main><footer className="footer shell"><span className="footer-brand">commission</span><span>つくる人の自由を、楽しみに。</span><span className="footer-note">決済は体験用です</span></footer>
  </>;
}

function RequestDetail({ request, role, limits, busy, act }: { request: RequestView; role: Role; limits: Limits; busy: boolean; act: (request: RequestView, action: 'accept' | 'cancel', files?: UploadInput[]) => Promise<void> }) {
  const canDeliver = role === 'creator' && ['accepted', 'delivered'].includes(request.state) && Date.now() < request.deliverBy;
  function cancel() {
    const message = request.state === 'accepted' ? '制作をギブアップし、依頼者に返金・ポイント返還しますか？' : role === 'creator' ? 'この依頼を見送りますか？支払確保は解除されます。' : 'この依頼を取り消しますか？支払確保は解除されます。';
    if (window.confirm(message)) void act(request, 'cancel');
  }
  return <article className="request-detail" aria-label="依頼の詳細">
    <div className="detail-heading"><span className="eyebrow">REQUEST DETAILS</span><Status request={request} /></div>
    <h2>依頼の詳細</h2><p className="detail-parties">{request.clientName} <Arrow /> {request.creatorName}</p>
    {request.state !== 'cancelled' && <ol className="timeline" aria-label="取引の流れ">{['依頼を送信', '承認・制作', '納品'].map((label, index) => {
      const step = request.state === 'delivered' ? 2 : request.state === 'accepted' ? 1 : 0;
      return <li className={index <= step ? 'reached' : ''} aria-current={index === step ? 'step' : undefined} key={label}><span>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>{label}</li>;
    })}</ol>}
    <div className="brief-block"><div className="brief-label">依頼内容 {request.nsfw && <span className="nsfw-label">閲覧注意</span>}</div><p>{request.brief}</p></div>
    <dl className="detail-facts"><div><dt>依頼金額</dt><dd>{yen(request.amount ?? 0)}</dd></div><div><dt>公開範囲</dt><dd>{visibilityLabels[request.visibility]}</dd></div><div><dt>送信日時</dt><dd>{date(request.createdAt)}</dd></div><div><dt>承認期限</dt><dd>{date(request.acceptBy)}</dd></div><div><dt>納品期限</dt><dd>{date(request.deliverBy)}</dd></div><div><dt>支払い</dt><dd>{request.paymentMethod === 'points' ? 'ポイント' : 'カード'} · {request.paymentState ? paymentLabels[request.paymentState] : '確認中'}</dd></div></dl>
    {request.state === 'cancelled' && <div className="cancellation-note"><h3>この依頼はキャンセルされました</h3><p>{reasons[request.cancelledReason ?? ''] ?? '取引は終了しています。'}{request.paymentState === 'refunded' ? request.paymentMethod === 'points' ? 'ポイントを残高に返還しました。' : 'カードへの返金処理が完了しました。' : '支払確保を解除しました。'}</p></div>}
    {request.state === 'accepting' && <div className="payment-pending">支払いの確認を待っています。制作は確認が完了してから始めてください。</div>}
    {request.files.length > 0 && <section className="delivery-files"><h3>届いたファイル <span>第{request.deliveryVersion}版</span></h3>{request.files.map((file) => <a key={file.id} href={`/api/files/${file.id}`} download={file.name}><span><strong>{file.name}</strong><small>{number.format(Math.max(1, Math.ceil(file.size / 1024)))} KB</small></span><Arrow down /></a>)}</section>}
    {request.state === 'awaiting_acceptance' && <div className="detail-actions">{role === 'creator' ? <><p>内容と納品期限を確認して、受けたい依頼を選んでください。承認すると支払いが確定します。</p><div className="action-buttons"><button className="primary" disabled={busy} onClick={() => void act(request, 'accept')}>{busy ? '処理しています…' : 'この依頼を承認する'}<Arrow /></button><button className="quiet-button" disabled={busy} onClick={cancel}>見送る</button></div></> : <><p>作り手の承認を待っています。承認されるまでは取り消せます。</p><button className="quiet-button" disabled={busy} onClick={cancel}>依頼を取り消す</button></>}</div>}
    {role === 'client' && request.state === 'accepted' && <p className="waiting-note">作り手が制作しています。作品が届くのをお待ちください。</p>}
    {canDeliver && (request.state === 'delivered' ? <details className="redelivery"><summary>ファイルを再納品する</summary><p className="hint">元の納品期限まで、作り手の判断でファイルを差し替えられます。</p><DeliveryForm request={request} limits={limits} busy={busy} act={act} /></details> : <DeliveryForm request={request} limits={limits} busy={busy} act={act} />)}
    {role === 'creator' && request.state === 'accepted' && <button className="give-up" onClick={cancel} disabled={busy}>制作をギブアップする</button>}
    <p className="detail-demo-note">支払い・返金は体験用です。実際のお金は動きません。</p>
  </article>;
}

function DeliveryForm({ request, limits, busy, act }: { request: RequestView; limits: Limits; busy: boolean; act: (request: RequestView, action: 'accept' | 'cancel', files?: UploadInput[]) => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function deliver(event: FormEvent) {
    event.preventDefault();
    if (reading || busy) return;
    setError('');
    if (files.length < 1 || files.length > limits.files || files.some((file) => file.size === 0) || files.reduce((sum, file) => sum + file.size, 0) > limits.uploadBytes) {
      setError(`空でないファイルを1〜${limits.files}個、合計${limits.uploadBytes / 1024 / 1024} MB以内で選んでください。`); return;
    }
    setReading(true);
    try {
      const encoded = await Promise.all(files.map(encodeFile));
      await act(request, 'accept', encoded);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ファイルを読み取れませんでした。'); }
    finally { setReading(false); }
  }
  useEffect(() => { setFiles([]); if (input.current) input.current.value = ''; }, [request.deliveryVersion]);
  return <form className="delivery-form" onSubmit={(event) => void deliver(event)}><h3>作品を届ける</h3><label className="upload-label" htmlFor={`files-${request.id}`}>納品ファイルを選択</label><div className="upload-control"><input ref={input} id={`files-${request.id}`} type="file" multiple required disabled={busy || reading} onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setError(''); }} /><span className="file-pick-button" aria-hidden="true">ファイルを選ぶ</span><span className="file-pick-caption" aria-hidden="true">{files.length ? `${files.length}個のファイル` : '選択されていません'}</span></div><p className="hint">最大{limits.files}ファイル · 合計{limits.uploadBytes / 1024 / 1024} MBまで · {date(request.deliverBy)}まで</p>{files.length > 0 && <ul className="selected-files">{files.map((file, index) => <li key={`${file.name}:${index}`}>{file.name}</li>)}</ul>}{error && <p className="inline-error" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy || reading}>{busy || reading ? '納品しています…' : 'ファイルを納品'}<Arrow /></button></form>;
}
