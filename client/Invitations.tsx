import { useEffect, useRef, useState } from 'react';
import { paymentLabels, type AuthOptions, type IdentitySession, type InvitationInput, type InvitationLinkResult, type InvitationView, type RequestInput, type SessionView, type Visibility } from '../src/shared';
import { api } from './api';
import { RequestForm, type RequestFormSettings } from './RequestForm';
import { Arrow } from './ui';
import { XLoginButton } from './Auth';

const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`;
const date = (value: number) => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
const visibilityLabels: Record<Visibility, string> = { public: '公開', anonymous: '匿名', hidden: '非表示' };
const reasons: Record<string, string> = {
  withdrawn: '依頼者が招待を取り消しました。', declined: 'この招待は見送られました。',
  expired: '招待の有効期限を過ぎました。', recipient_blocked: '招待の受信が停止されました。',
};

function useInvitationActions() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  async function run(action: () => Promise<void>) {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError('');
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); return false; }
    finally { lock.current = false; setBusy(false); }
  }
  async function mutate<T>(path: string, body: unknown = {}, token?: string): Promise<T> {
    const payload = JSON.stringify({ body, token });
    let attempt = keys.current.get(path);
    if (!attempt || attempt.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      keys.current.set(path, attempt);
    }
    const result = await api<T>(path, body, attempt.key, token);
    keys.current.delete(path);
    return result;
  }
  return { busy, error, run, mutate };
}

function InvitationFacts({ invitation }: { invitation: InvitationView }) {
  return <>
    <div className="brief-block"><div className="brief-label">依頼内容 {invitation.nsfw && <span className="nsfw-label">閲覧注意</span>}</div><p>{invitation.brief}</p></div>
    <dl className="detail-facts">
      <div><dt>依頼金額</dt><dd>{yen(invitation.amount)}</dd></div>
      <div><dt>公開範囲</dt><dd>{visibilityLabels[invitation.visibility]}</dd></div>
      <div><dt>招待の作成日時</dt><dd>{date(invitation.createdAt)}</dd></div>
      <div><dt>受諾期限</dt><dd>{date(invitation.expiresAt)}</dd></div>
      <div><dt>納品期限</dt><dd>{date(invitation.deliverBy)}</dd></div>
      <div><dt>支払い</dt><dd>カード · {paymentLabels[invitation.paymentState]}</dd></div>
    </dl>
    {invitation.state === 'cancelled' && <div className="cancellation-note"><h3>この招待の受付は終了しました</h3><p>{reasons[invitation.cancelledReason ?? ''] ?? '招待は終了しています。'}支払確保は解除されました。</p></div>}
  </>;
}

export function Invitations({ settings, session, options, openRequest }: { settings: RequestFormSettings; session: SessionView; options: AuthOptions; openRequest: (id: string) => void }) {
  const demo = options.mode === 'demo';
  const [items, setItems] = useState<InvitationView[]>([]);
  const [handle, setHandle] = useState('');
  const [compose, setCompose] = useState(true);
  const [notice, setNotice] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
  const actions = useInvitationActions();

  async function refresh() {
    const data = await api<{ invitations: InvitationView[] }>('/invitations');
    setItems(data.invitations);
  }
  useEffect(() => { void actions.run(refresh); }, []);
  useEffect(() => { if (actions.error || notice) document.querySelector('.invitations-section .message')?.scrollIntoView({ block: 'nearest' }); }, [actions.error, notice]);
  const update = (invitation: InvitationView) => setItems((current) => [invitation, ...current.filter((item) => item.id !== invitation.id)]);
  function saveLink(result: InvitationLinkResult) {
    update(result.invitation);
    setLinks((current) => {
      const next = { ...current };
      if (result.token) next[result.invitation.id] = `${window.location.origin}/#invite=${result.token}`;
      else delete next[result.invitation.id];
      return next;
    });
  }
  async function submit(request: RequestInput) {
    await actions.run(async () => {
      const input: InvitationInput = { recipientHandle: handle, brief: request.brief, amount: request.amount,
        visibility: request.visibility, nsfw: request.nsfw, agreeToRules: request.agreeToRules };
      const result = await actions.mutate<InvitationLinkResult>('/invitations', input);
      saveLink(result); setCompose(false);
      setNotice(result.token ? '招待リンクを作成しました。相手が連絡を受け付けているDMやメールで共有してください。' : '作成済みの招待を確認しました。共有するリンクを再発行してください。');
    });
  }
  async function reissue(invitation: InvitationView) {
    if (!window.confirm('古いリンクを無効にして、新しいリンクを作成しますか？受諾期限・納品期限は変わりません。')) return;
    setLinks((current) => { const next = { ...current }; delete next[invitation.id]; return next; });
    await actions.run(async () => {
      const result = await actions.mutate<InvitationLinkResult>(`/invitations/${invitation.id}/reissue`);
      saveLink(result);
      setNotice(result.token ? 'リンクを再発行しました。古いリンクは使えません。' : '再発行済みのリンクを表示できません。もう一度、再発行してください。');
    });
  }
  async function withdraw(invitation: InvitationView) {
    if (!window.confirm('この招待を取り消し、支払確保を解除しますか？')) return;
    await actions.run(async () => {
      update(await actions.mutate<InvitationView>(`/invitations/${invitation.id}/withdraw`));
      setLinks((current) => { const next = { ...current }; delete next[invitation.id]; return next; });
      setNotice('招待を取り消し、支払確保を解除しました。');
    });
  }
  async function copy(link: string) {
    await actions.run(async () => {
      if (!navigator.clipboard) throw new Error('リンク欄を選択してコピーしてください。');
      try { await navigator.clipboard.writeText(link); }
      catch { throw new Error('コピーできませんでした。リンク欄を選択してコピーしてください。'); }
      setNotice('招待リンクをコピーしました。');
    });
  }
  return <section className="invitations-section">
    <div className="section-heading"><div><p className="eyebrow">AN INVITATION TO CREATE</p><h1>まだ出会っていない、依頼を。</h1></div></div>
    <p className="section-copy">サービスに登録していない作り手にも、招待リンクで依頼を届けられます。</p>
    {actions.error && <div className="message error" role="alert">{actions.error}</div>}
    {notice && <div className="message success" role="status">{notice}</div>}
    {compose ? <div className="compose-layout invitation-compose">
      <aside className="invitation-guide"><span className="envelope-mark" aria-hidden="true">↗</span><h2>受け取るところから、<br />はじめられる。</h2><ol><li>相手を指定して、リンクを作る。</li><li>相手が受け付けている連絡先で共有する。</li><li>相手がアカウントを確認し、受けるか選ぶ。</li></ol><p>内容を確認するだけなら登録は不要です。受諾するときに登録します。</p><p>リンクの作成だけでは、相手への通知は送られません。</p><p className="hint">{demo ? '現在は体験用のSNSアカウント・決済を使用します。実際のSNSへの接続や請求はありません。' : '宛先のXアカウントで確認した本人だけが、招待の内容を読めます。決済・金額・期限は体験用です。実際の請求は発生しません。'}</p>{!options.invitationLookup && <p className="inline-error" role="status">現在、招待先の確認を利用できません。作成済みの招待は下で確認できます。</p>}</aside>
      <RequestForm settings={settings} session={session} busy={actions.busy || !options.invitationLookup} submit={submit} invitation={{ handle, changeHandle: setHandle, demo }} />
    </div> : <button className="quiet-button new-invitation" onClick={() => { setCompose(true); setNotice(''); setHandle(''); }}>別の招待を作る <Arrow /></button>}
    <div className="invitation-list-heading"><h2>作成した招待</h2><button className="text-button" disabled={actions.busy} onClick={() => void actions.run(refresh)}>最新の状態を確認</button></div>
    {items.length === 0 ? <p className="empty-invitations">まだ招待はありません。</p> : <div className="invitation-list">
      {items.map((invitation) => <article className="request-detail invitation-card" key={invitation.id} aria-label={`@${invitation.recipientHandle}への招待`}>
        <div className="detail-heading"><span className="eyebrow">INVITATION</span><span className={`status status-${invitation.state === 'pending' ? 'awaiting_acceptance' : invitation.state}`}><i />{invitation.state === 'pending' ? '受諾待ち' : invitation.state === 'accepted' ? '受諾済み' : '受付終了'}</span></div>
        <h2>{invitation.recipientName}</h2><p className="detail-parties">@{invitation.recipientHandle}</p>
        <InvitationFacts invitation={invitation} />
        {invitation.state === 'pending' && <div className="invitation-share">
          {links[invitation.id] ? <><label htmlFor={`link-${invitation.id}`}>招待リンク</label><div className="link-row"><input id={`link-${invitation.id}`} className="text-input" value={links[invitation.id]} readOnly onFocus={(event) => event.target.select()} /><button className="quiet-button" disabled={actions.busy} onClick={() => void copy(links[invitation.id]!)}>コピー</button></div></> : <p className="hint">共有するリンクが必要な場合は再発行してください。古いリンクは無効になります。</p>}
          <p className="hint">リンクを開いた相手は、宛先のアカウントで確認してから内容を読めます。再発行しても期限は延びません。</p>
          <div className="action-buttons"><button className="quiet-button" disabled={actions.busy} onClick={() => void reissue(invitation)}>リンクを再発行</button><button className="text-button" disabled={actions.busy} onClick={() => void withdraw(invitation)}>招待を取り消す</button></div>
        </div>}
        {invitation.requestId && <button className="primary" onClick={() => openRequest(invitation.requestId!)}>依頼一覧で確認 <Arrow /></button>}
      </article>)}
    </div>}
  </section>;
}

export function InvitationLanding({ token, options, initialError }: { token: string; options: AuthOptions; initialError: string }) {
  const demo = options.mode === 'demo';
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const actions = useInvitationActions();

  async function load() {
    setInvitation(null);
    const current = await api<IdentitySession | null>('/auth/identity');
    setIdentity(current); setReady(true);
    if (!current) return;
    setBlocked((await api<{ blocked: boolean }>('/invitation-preference')).blocked);
    setInvitation(await api<InvitationView>('/invitation', undefined, undefined, token));
  }
  useEffect(() => { void actions.run(load); }, [token]);
  useEffect(() => { if (actions.error || notice) document.querySelector('.invitation-reader .message')?.scrollIntoView({ block: 'nearest' }); }, [actions.error, notice]);
  async function authenticate(persona: 'recipient' | 'other') {
    setInvitation(null); setAgreed(false); setNotice('');
    await actions.run(async () => {
      await api<IdentitySession>('/demo/identity', { persona });
      await load();
    });
  }
  async function accept() {
    await actions.run(async () => {
      setInvitation(await actions.mutate<InvitationView>('/invitation/accept', { agreeToRules: agreed }, token));
      setIdentity(await api<IdentitySession>('/auth/identity'));
      setNotice('依頼を受け取りました。依頼一覧で支払状況と納品期限を確認してください。');
    });
  }
  async function decline() {
    if (!window.confirm('この招待を見送りますか？登録は行わず、支払確保を解除します。')) return;
    await actions.run(async () => {
      setInvitation(await actions.mutate<InvitationView>('/invitation/decline', {}, token));
      setNotice('招待を見送りました。');
    });
  }
  async function preference() {
    if (!blocked && !window.confirm('今後の招待を停止しますか？未受諾の招待はすべて見送られ、支払確保が解除されます。')) return;
    await actions.run(async () => {
      const next = await api<{ blocked: boolean }>('/invitation-preference', { blocked: !blocked });
      setBlocked(next.blocked);
      setNotice(next.blocked ? '招待の受信を停止しました。' : '招待の受信を再開しました。');
      if (invitation) setInvitation(await api<InvitationView>('/invitation', undefined, undefined, token));
    });
  }
  async function logout() {
    setInvitation(null); setNotice(''); setAgreed(false);
    await actions.run(async () => {
      await api('/auth/logout', {});
      setIdentity(null); setBlocked(false);
    });
  }

  return <>
    <div className="demo-banner"><span className="demo-mark">DEMO</span>{demo ? '体験用のSNSアカウント · 実際の請求は発生しません' : '決済は体験用 · 実際の請求は発生しません'}</div>
    <header className="header shell invitation-header"><a className="wordmark" href="/">commission<span>↗</span></a><span>創作への招待</span></header>
    <main className="shell invitation-landing">
      <div className="invitation-intro"><p className="eyebrow">SOMETHING TO CREATE</p><h1>あなたの創作に、<br />届いた招待。</h1><p>宛先のSNSアカウントで確認すると、<br />依頼内容と金額を読むことができます。</p></div>
      <div className="invitation-reader">
        {initialError && <div className="message error" role="alert">{initialError}</div>}
        {actions.error && <div className="message error" role="alert">{actions.error} <button disabled={actions.busy} onClick={() => void actions.run(load)}>再確認</button></div>}
        {notice && <div className="message success" role="status">{notice}</div>}
        {!ready && !actions.error && <p className="loading" role="status">招待を開いています…</p>}
        <section className="identity-card" aria-label="アカウントの確認">
          <div><p className="eyebrow">ACCOUNT</p><h2>{identity ? identity.account.name : 'アカウントを確認'}</h2>
            <p>{identity ? `@${identity.account.handle} · ${identity.registered ? '登録済み' : 'サービスには未登録'}` : '確認するだけでは、サービスへの登録は行われません。'}</p></div>
          {identity && <button className="text-button" disabled={actions.busy} onClick={() => void logout()}>ログアウト</button>}
          {demo ? <div className="demo-identities"><span>体験用SNSアカウント</span><div className="action-buttons"><button className="quiet-button" disabled={actions.busy} onClick={() => void authenticate('recipient')}>澪のアカウントで確認</button><button className="quiet-button" disabled={actions.busy} onClick={() => void authenticate('other')}>空のアカウントで確認</button></div><p className="hint">実際のSNSへの接続や投稿は行いません。</p></div> : <div className="x-invitation-identity">{!identity && (options.xLogin ? <XLoginButton label="Xでアカウントを確認" disabled={actions.busy} /> : <p>現在、アカウントの確認を利用できません。</p>)}<p className="hint">XのユーザーID・表示名・ユーザー名を、ログインと招待先の確認に使用します。登録すると、表示名は依頼者・作り手の名前として使われます。あなたの代わりに投稿・DMを送ることはありません。</p></div>}
        </section>
        {invitation && <article className="request-detail" aria-label="届いた招待">
          <div className="detail-heading"><span className="eyebrow">INVITATION DETAILS</span><span className="status"><i />{invitation.state === 'pending' ? '受諾待ち' : invitation.state === 'accepted' ? '受諾済み' : '受付終了'}</span></div>
          <h2>依頼の内容</h2><p className="detail-parties">{invitation.clientName}からの依頼</p>
          <InvitationFacts invitation={invitation} />
          {invitation.state === 'pending' && <div className="detail-actions">
            <p>受けるかどうかは自由に選べます。確認・辞退だけなら登録は不要です。受諾すると依頼者の支払いが確定します。</p>
            <p>見積もり・打ち合わせ・リテイク要求はありません。納品期限は招待の作成日から数え、受諾しても延びません。</p>
            <label className="checkbox-line invitation-agreement"><input type="checkbox" checked={agreed} disabled={actions.busy} onChange={(event) => setAgreed(event.target.checked)} /><span>{identity?.registered ? '依頼のルールを確認し、この内容と金額・期限で受けることに同意します。' : 'サービスに登録し、依頼のルールに同意して、この内容と金額・期限で受けることを確認します。'}</span></label>
            <div className="action-buttons"><button className="primary" disabled={actions.busy || !agreed || blocked} onClick={() => void accept()}>{identity?.registered ? 'この依頼を受ける' : '登録して依頼を受ける'}<Arrow /></button><button className="quiet-button" disabled={actions.busy} onClick={() => void decline()}>見送る</button></div>
          </div>}
          {invitation.requestId && <a className="primary" href={`/#request=${invitation.requestId}`}>依頼一覧へ <Arrow /></a>}
        </article>}
        {identity && <section className="invitation-preferences" aria-label="招待の受信設定"><div><h2>招待の受信設定</h2><p>{blocked ? '招待の受信を停止しています。' : '今後の招待が不要な場合は、登録せずに受信を停止できます。'}</p></div><button className="text-button" disabled={actions.busy} onClick={() => void preference()}>{blocked ? '受信を再開する' : '今後の招待を停止する'}</button></section>}
      </div>
    </main>
    <footer className="footer shell"><span className="footer-brand">commission</span><span>つくる人の自由を、楽しみに。</span></footer>
  </>;
}
