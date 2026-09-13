import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { genres, paymentLabels, requestLabels, type CreatorView, type Genre, type RequestInput, type RequestView, type Role, type SessionView, type UploadInput, type Visibility } from '../src/shared';
import { api, encodeFile } from './api';

interface Limits { brief: number; files: number; uploadBytes: number; maximumAmount: number }
interface CreatorSettings { creator: CreatorView; limits: Limits }
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
function Arrow({ down = false }: { down?: boolean }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={down ? 'arrow-down' : ''}>
    <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" />
  </svg>;
}
function Status({ request }: { request: RequestView }) {
  return <span className={`status status-${request.state}`}><i />{requestLabels[request.state]}</span>;
}

export function App() {
  const [settings, setSettings] = useState<CreatorSettings | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [page, setPage] = useState<Page>('compose');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const actionLock = useRef(false);
  const refreshTicket = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current;
    const [nextSession, data] = await Promise.all([api<SessionView>('/session'), api<{ requests: RequestView[] }>('/requests')]);
    if (ticket !== refreshTicket.current) return;
    setSession(nextSession);
    setRequests(data.requests);
    setSelectedId((id) => data.requests.some((request) => request.id === id) ? id : data.requests[0]?.id ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      setError('');
      const [creatorSettings, existing] = await Promise.all([api<CreatorSettings>('/creator'), api<SessionView | null>('/demo/session')]);
      const nextSession = existing ?? await api<SessionView>('/demo/session', { role: 'client' });
      const data = await api<{ requests: RequestView[] }>('/requests');
      if (!active) return;
      setSettings(creatorSettings);
      setSession(nextSession);
      setRequests(data.requests);
      setSelectedId(data.requests[0]?.id ?? null);
      setPage(nextSession.role === 'creator' ? 'requests' : 'compose');
    };
    void boot().catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'ページを読み込めませんでした。'); });
    return () => { active = false; };
  }, [bootAttempt]);

  useEffect(() => {
    if (!session) return;
    const poll = () => {
      if (document.hidden || actionLock.current) return;
      void refresh().catch(() => setError('最新の状態を確認できません。接続を確認して、再読み込みしてください。'));
    };
    const timer = window.setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [Boolean(session), refresh]);

  useEffect(() => { if (error || notice) document.querySelector('.message')?.scrollIntoView({ block: 'nearest' }); }, [error, notice]);

  async function run(action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    refreshTicket.current++;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function mutation(path: string, body: unknown): Promise<RequestView> {
    const payload = JSON.stringify(body);
    let attempt = keys.current.get(path);
    if (!attempt || attempt.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      keys.current.set(path, attempt);
    }
    const result = await api<RequestView>(path, body, attempt.key);
    keys.current.delete(path);
    return result;
  }
  async function changeRole(role: Role) {
    await run(async () => {
      await api<SessionView>('/demo/session', { role });
      await refresh();
      setPage(role === 'creator' ? 'requests' : 'compose');
    });
  }
  const navigate = (next: Page) => { setPage(next); setError(''); setNotice(''); };
  async function submit(input: RequestInput) {
    await run(async () => {
      const created = await mutation('/requests', input);
      setSelectedId(created.id);
      setRequests((current) => [created, ...current.filter((request) => request.id !== created.id)]);
      setPage('requests');
      setNotice('依頼を送りました。作り手からの承認をお待ちください。');
      await refresh();
    });
  }
  async function act(request: RequestView, action: 'accept' | 'cancel', files?: UploadInput[]) {
    await run(async () => {
      const updated = await mutation(`/requests/${request.id}/${files ? 'deliver' : action}`, files ? { files } : {});
      setRequests((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(files ? 'ファイルを納品しました。' : action === 'accept' ? '依頼を承認しました。納品期限までに作品をお届けください。' : '依頼をキャンセルしました。');
      await refresh();
    });
  }
  const selected = requests.find((request) => request.id === selectedId);

  return <>
    <div className="demo-banner"><span className="demo-mark">DEMO</span>体験用 · 実際の請求は発生しません</div>
    <header className="header shell">
      <button className="wordmark" onClick={() => navigate(session?.role === 'creator' ? 'requests' : 'compose')} aria-label="commission ホーム">commission<span>↗</span></button>
      {session && <>
        <nav aria-label="メインナビゲーション">
          {session.role === 'client' && <button aria-current={page === 'compose' ? 'page' : undefined} onClick={() => navigate('compose')}>依頼を送る</button>}
          <button aria-current={page === 'requests' ? 'page' : undefined} onClick={() => navigate('requests')}>依頼一覧 <span className="count">{requests.length}</span></button>
        </nav>
        <div className="role-switch" aria-label="体験する役割">
          <button aria-pressed={session.role === 'client'} disabled={busy} onClick={() => void changeRole('client')}>依頼者で体験</button>
          <button aria-pressed={session.role === 'creator'} disabled={busy} onClick={() => void changeRole('creator')}>作り手で体験</button>
        </div>
      </>}
    </header>
    <main className="shell">
      {error && <div className="message error" role="alert">{error} <button onClick={() => session ? void run(refresh) : setBootAttempt((value) => value + 1)} disabled={busy}>再読み込み</button></div>}
      {notice && <div className="message success" role="status">{notice}</div>}
      {!settings || !session ? <div className="loading" role="status">{error ? '接続をお確かめください。' : 'ページを開いています…'}</div> : page === 'compose' && session.role === 'client' ? <>
        <section className="intro">
          <p className="eyebrow"><span /> A LITTLE TRUST, A NEW CREATION</p>
          <h1>好きな創作を、<br />その人の自由で。</h1>
          <p className="intro-copy">届けたい言葉と、応援の気持ちを。<br />あとは、作り手の感性におまかせ。</p>
          <span className="intro-note" aria-hidden="true">Leave a little<br /><i>room for wonder.</i></span>
        </section>
        <div className="compose-layout">
          <CreatorCard creator={settings.creator} />
          <RequestForm settings={settings} session={session} busy={busy} submit={submit} />
        </div>
      </> : <section className="requests-section">
        <div className="section-heading"><div><p className="eyebrow">YOUR COMMISSIONS</p><h1>{session.role === 'creator' ? '届いた依頼' : 'あなたの依頼'}</h1></div><span className="total">{requests.length} 件</span></div>
        {requests.length ? <div className="requests-layout">
          <div className="request-list" aria-label="依頼を選択">
            {requests.map((request) => <button key={request.id} className={`request-item ${request.id === selectedId ? 'selected' : ''}`} aria-pressed={request.id === selectedId} onClick={() => { setSelectedId(request.id); setNotice(''); setError(''); }}>
              <span className="request-item-top"><Status request={request} /><span>{genres[request.genre]}</span></span>
              <span className="request-excerpt">{request.brief}</span>
              <span className="request-item-bottom"><span>{session.role === 'creator' ? request.clientName : request.creatorName}</span><span>{yen(request.amount ?? 0)}</span></span>
            </button>)}
          </div>
          {selected && <RequestDetail key={`${session.role}:${selected.id}`} request={selected} role={session.role} limits={settings.limits} busy={busy} act={act} />}
        </div> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">c.</span><h2>まだ依頼はありません</h2><p>{session.role === 'creator' ? '依頼が届くと、ここで内容を確認できます。' : '気持ちを言葉にして、はじめての依頼を。'}</p>{session.role === 'client' && <button className="primary" onClick={() => navigate('compose')}>依頼を送る <Arrow /></button>}</div>}
      </section>}
    </main>
    <footer className="footer shell"><span className="footer-brand">commission</span><span>つくる人の自由を、楽しみに。</span><span className="footer-note">体験用プロフィール・決済</span></footer>
  </>;
}

function CreatorCard({ creator }: { creator: CreatorView }) {
  return <aside className="creator-card">
    <div className="creator-art" aria-hidden="true"><span className="art-sun" /><span className="art-hill hill-back" /><span className="art-hill hill-front" /><span className="art-line" /><span className="art-caption">somewhere, quietly.</span></div>
    <div className="creator-content">
      <div className="accepting"><span />リクエスト受付中</div>
      <h2>{creator.name}</h2>
      <p className="creator-bio">物語の気配や、静かな風景が好きです。<br />いただいた言葉から、自由に作ります。</p>
      <div className="creator-price"><span>推奨金額</span><strong>{yen(creator.recommendedAmount)}</strong></div>
      <dl className="creator-terms"><div><dt>最低金額</dt><dd>{yen(creator.minimumAmount)}</dd></div><div><dt>承認期限</dt><dd>送信から{creator.acceptanceDays}日</dd></div><div><dt>納品期限</dt><dd>送信から{creator.deliveryDays}日</dd></div></dl>
      <p className="sample-profile">体験用のプロフィール・金額・期限です。</p>
    </div>
    <div className="side-note"><span className="note-number">01 — 03</span><p>言葉を送る。<br />自由な創作を待つ。<br />届いた作品を楽しむ。</p></div>
  </aside>;
}

function RequestForm({ settings: { creator, limits }, session, busy, submit }: { settings: CreatorSettings; session: SessionView; busy: boolean; submit: (input: RequestInput) => Promise<void> }) {
  const [genre, setGenre] = useState<Genre>('illustration');
  const [brief, setBrief] = useState('');
  const [amount, setAmount] = useState(String(creator.recommendedAmount));
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'points'>('card');
  const [nsfw, setNsfw] = useState(false);
  const [agreed, setAgreed] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit({ creatorId: creator.id, genre, brief, amount: Number(amount), visibility, paymentMethod, nsfw, agreeToRules: agreed });
  }
  return <form className="request-form" onSubmit={(event) => void onSubmit(event)}>
    <div className="form-heading"><span className="eyebrow">NEW REQUEST</span><h2>依頼を送る</h2><p>一度のメッセージに、お願いしたいことをまとめて。</p></div>
    <fieldset disabled={busy} className="form-fields">
      <div className="field"><label htmlFor="genre">ジャンル</label><select id="genre" value={genre} onChange={(event) => setGenre(event.target.value as Genre)}>{Object.entries(genres).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field"><div className="label-row"><label htmlFor="brief">依頼内容</label><span className="required-label">必須</span></div><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} required maxLength={limits.brief} rows={7} placeholder="描いてほしい風景や、聴いてみたい言葉。好きなところや参考資料のURLも、こちらに。" aria-describedby="brief-hint brief-count" /><div className="field-meta"><span id="brief-hint">送信後の打ち合わせやリテイク要求はできません。</span><span id="brief-count">{number.format(brief.length)} / {number.format(limits.brief)}</span></div></div>
      <div className="field"><label htmlFor="amount">依頼金額</label><div className="amount-row"><div className="amount-input"><span aria-hidden="true">¥</span><input id="amount" type="number" inputMode="numeric" min={creator.minimumAmount} max={limits.maximumAmount} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} required aria-describedby="amount-hint" /></div><button type="button" className="text-button" onClick={() => setAmount(String(creator.recommendedAmount))}>推奨額にする</button></div><p className="hint" id="amount-hint">最低 {yen(creator.minimumAmount)} · 金額は第三者には公開されません。</p></div>
      <fieldset className="field visibility-options"><legend>公開範囲</legend><div className="choice-grid">
        {([
          ['public', '公開', '依頼者名・依頼文・作品のプレビューを公開'],
          ['anonymous', '匿名', '依頼文・プレビューを公開。作り手にも名前を知らせない'],
          ['hidden', '非表示', '依頼文・作品をサービス内で一般公開しない'],
        ] as const).map(([value, title, description]) => <label className={`choice ${visibility === value ? 'checked' : ''}`} key={value}><input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} /><span className="choice-title">{title}</span><span className="choice-description">{description}</span></label>)}
      </div><p className="hint">非表示でも、作り手によるSNS等での作品発表は制限しません。秘密保持や権利譲渡を意味しません。</p></fieldset>
      <label className="checkbox-line"><input type="checkbox" checked={nsfw} onChange={(event) => setNsfw(event.target.checked)} /><span>成人向けなど、閲覧に注意が必要な内容を含む</span></label>
      <fieldset className="field payment-options"><legend>支払方法</legend><div className="payment-choices"><label className={paymentMethod === 'card' ? 'checked' : ''}><input type="radio" name="payment" checked={paymentMethod === 'card'} onChange={() => setPaymentMethod('card')} /><span>カード<span className="payment-subtitle">体験用</span></span></label><label className={paymentMethod === 'points' ? 'checked' : ''}><input type="radio" name="payment" checked={paymentMethod === 'points'} onChange={() => setPaymentMethod('points')} /><span>ポイント<span className="payment-subtitle">利用可能 {number.format(session.pointsAvailable)} pt</span></span></label></div>
        <p className="hint">{paymentMethod === 'card' ? '送信時に利用枠を確保し、承認時に請求が確定します。体験用のため、カード情報の入力や実際の請求はありません。' : 'ポイントは事前にチャージして使うサービス内残高です。送信時に代金分を確保し、承認時に差し引きます。ここでは体験用の残高を使います。'}</p>
        {paymentMethod === 'points' && <p className="wallet-summary">残高 {number.format(session.pointsBalance)} pt · 確保中 {number.format(session.pointsBalance - session.pointsAvailable)} pt</p>}
      </fieldset>
      <div className="agreement"><label className="checkbox-line"><input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>見積もり・打ち合わせ・リテイク要求をせず、表現や仕上がりを作り手に任せることに同意します。</span></label><p>承認前の取消・期限切れでは支払確保を解除します。承認後の納品期限切れ・ギブアップでは返金またはポイント返還となります。</p></div>
      <div className="submit-row"><span>承認・納品の期限は<br />依頼の送信日から数えます。</span><button className="primary" type="submit" disabled={busy}>{busy ? '送信しています…' : '支払いを確保して送信'}<Arrow /></button></div>
    </fieldset>
  </form>;
}

function RequestDetail({ request, role, limits, busy, act }: { request: RequestView; role: Role; limits: Limits; busy: boolean; act: (request: RequestView, action: 'accept' | 'cancel', files?: UploadInput[]) => Promise<void> }) {
  const canDeliver = role === 'creator' && ['accepted', 'delivered'].includes(request.state) && Date.now() < request.deliverBy;
  function cancel() {
    const message = request.state === 'accepted' ? '制作をギブアップし、依頼者に返金・ポイント返還しますか？' : role === 'creator' ? 'この依頼を見送りますか？支払確保は解除されます。' : 'この依頼を取り消しますか？支払確保は解除されます。';
    if (window.confirm(message)) void act(request, 'cancel');
  }
  return <article className="request-detail" aria-label="依頼の詳細">
    <div className="detail-heading"><span className="eyebrow">REQUEST DETAILS</span><Status request={request} /></div>
    <h2>{genres[request.genre]}の依頼</h2><p className="detail-parties">{request.clientName} <Arrow /> {request.creatorName}</p>
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
