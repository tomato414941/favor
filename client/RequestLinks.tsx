import { useEffect, useRef, useState } from 'react';
import type { AuthOptions, IdentitySession, RequestLinkInput, RequestLinkResult, RequestLinkView } from '../src/shared';
import { paymentLabels } from '../src/shared';
import { api } from './api';
import { LocalAccountForm, XLoginButton } from './Auth';
import { RequestForm, type RequestFormSettings } from './RequestForm';
import { Arrow } from './ui';

const yen = (value: number) => `¥${new Intl.NumberFormat('ja-JP').format(value)}`;
const date = (value: number) => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
const visibility = { public: '公開', anonymous: '匿名', hidden: '非表示' };

function useLinkActions() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function mutate<T>(path: string, body: unknown = {}, token?: string): Promise<T> {
    const payload = JSON.stringify({ body, token });
    let attempt = keys.current.get(path);
    if (!attempt || attempt.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      keys.current.set(path, attempt);
    }
    const result = await api<T>(path, body, attempt.key, undefined, token);
    keys.current.delete(path);
    return result;
  }
  return { busy, error, run, mutate };
}

function LinkFacts({ link }: { link: RequestLinkView }) {
  return <>
    <div className="brief-block"><div className="brief-label">依頼内容 {link.nsfw && <span className="nsfw-label">閲覧注意</span>}</div><p>{link.brief}</p></div>
    <dl className="detail-facts">
      <div><dt>依頼金額</dt><dd>{yen(link.amount)}</dd></div><div><dt>納品後の公開範囲</dt><dd>{visibility[link.visibility]}</dd></div>
      <div><dt>作成日時</dt><dd>{date(link.createdAt)}</dd></div><div><dt>受諾期限</dt><dd>{date(link.expiresAt)}</dd></div>
      <div><dt>納品期限</dt><dd>{date(link.deliverBy)}</dd></div><div><dt>支払い</dt><dd>カード · {paymentLabels[link.paymentState]}</dd></div>
    </dl>
  </>;
}

export function RequestLinks({ settings, composing, onCreated }: {
  settings: RequestFormSettings; composing: boolean; onCreated: () => void;
}) {
  const [items, setItems] = useState<RequestLinkView[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const actions = useLinkActions();
  const ticket = useRef(0);
  async function refresh() {
    const current = ++ticket.current;
    const result = await api<{ links: RequestLinkView[] }>('/links');
    if (current === ticket.current) setItems(result.links);
  }
  useEffect(() => { void actions.run(refresh); return () => { ticket.current++; }; }, [composing]);
  useEffect(() => {
    if (composing || actions.busy) return;
    const timer = window.setInterval(() => { if (!document.hidden) void actions.run(refresh); }, 5000);
    return () => window.clearInterval(timer);
  }, [composing, actions.busy]);
  const update = (link: RequestLinkView) => {
    ticket.current++;
    setItems((current) => [link, ...current.filter((item) => item.id !== link.id)]);
  };
  function save(result: RequestLinkResult) {
    update(result.link);
    setUrls((current) => {
      const next = { ...current };
      if (result.token) next[result.link.id] = `${window.location.origin}/#link=${result.token}`;
      else delete next[result.link.id];
      return next;
    });
  }
  async function submit(input: RequestLinkInput) {
    await actions.run(async () => {
      const result = await actions.mutate<RequestLinkResult>('/links', input);
      save(result);
      setNotice(result.token ? '依頼リンクを作成しました。依頼する相手だけに共有してください。' : '作成済みの依頼を確認しました。共有するリンクを再発行してください。');
      onCreated();
    });
  }
  async function reissue(link: RequestLinkView) {
    if (!window.confirm('古いリンクを無効にして再発行しますか？受諾期限・納品期限は変わりません。')) return;
    await actions.run(async () => {
      setUrls((current) => { const next = { ...current }; delete next[link.id]; return next; });
      const result = await actions.mutate<RequestLinkResult>(`/links/${link.id}/reissue`);
      save(result);
      setNotice(result.token ? 'リンクを再発行しました。相手に新しいリンクを共有してください。' : '再発行済みのリンクを表示できません。もう一度再発行してください。');
    });
  }
  async function withdraw(link: RequestLinkView) {
    if (!window.confirm('この依頼を取り消しますか？リンクを無効にし、支払確保を解除します。')) return;
    await actions.run(async () => {
      update(await actions.mutate<RequestLinkView>(`/links/${link.id}/withdraw`));
      setUrls((current) => { const next = { ...current }; delete next[link.id]; return next; });
      setNotice('依頼を取り消し、支払確保を解除しました。');
    });
  }
  async function copy(url: string) {
    await actions.run(async () => {
      if (!navigator.clipboard) throw new Error('リンク欄を選択してコピーしてください。');
      try { await navigator.clipboard.writeText(url); }
      catch { throw new Error('コピーできませんでした。リンク欄を選択してコピーしてください。'); }
      setNotice('依頼リンクをコピーしました。');
    });
  }
  const pending = items.filter((link) => link.state !== 'accepted');
  return <section className="request-links-section">
    {actions.error && <div className="message error" role="alert">{actions.error} <button disabled={actions.busy} onClick={() => void actions.run(refresh)}>再読み込み</button></div>}
    {!composing && notice && <div className="message success" role="status">{notice}</div>}
    {composing ? <>
      <section className="intro"><p className="eyebrow"><span /> A LITTLE TRUST, A NEW CREATION</p><h1>好きな創作を、<br />その人の自由で。</h1><p className="intro-copy">お願いしたいことを、ひとつのリンクに。<br />受け取る人のペースで、創作がはじまる。</p><span className="intro-note" aria-hidden="true">Leave a little<br /><i>room for wonder.</i></span></section>
      <div className="compose-layout invitation-compose"><aside className="invitation-guide"><span className="envelope-mark" aria-hidden="true">↗</span><h2>言葉をまとめて、<br />相手に届ける。</h2><ol><li>内容と金額を決める。</li><li>非公開リンクを相手に渡す。</li><li>相手が受けると、制作がはじまる。</li></ol><p>相手は登録せずに内容を確認できます。受けるときに登録・ログインします。</p><p>リンクを知っている人は閲覧・受諾できます。DMやメールで相手だけに共有してください。</p><p className="hint">受諾期限は作成から{settings.terms.acceptanceDays}日、納品期限は作成から{settings.terms.deliveryDays}日です。リンクの再発行でも期限は変わりません。</p></aside><RequestForm settings={settings} busy={actions.busy} submit={submit} /></div>
    </> : <><div className="invitation-list-heading"><h2>送った依頼リンク</h2><button className="text-button" disabled={actions.busy} onClick={() => void actions.run(refresh)}>最新の状態を確認</button></div>
      {pending.length ? <div className="invitation-list">{pending.map((link) => <article className="request-detail invitation-card" key={link.id} aria-label="依頼リンク">
        <div className="detail-heading"><span className="eyebrow">REQUEST LINK</span><span className={`status status-${link.state === 'pending' ? 'awaiting_acceptance' : 'cancelled'}`}><i />{link.state === 'pending' ? '受諾待ち' : '受付終了'}</span></div>
        <h2>{link.state === 'pending' ? '相手の受諾を待っています' : 'この依頼の受付は終了しました'}</h2><LinkFacts link={link} />
        {link.state === 'pending' ? <div className="invitation-share">{urls[link.id] ? <><label htmlFor={`link-${link.id}`}>依頼リンク</label><div className="link-row"><input id={`link-${link.id}`} className="text-input" value={urls[link.id]} readOnly onFocus={(event) => event.target.select()} /><button className="quiet-button" disabled={actions.busy} onClick={() => void copy(urls[link.id]!)}>コピー</button></div></> : <p className="hint">共有するリンクが必要な場合は再発行してください。</p>}<p className="hint">相手だけに共有してください。リンクの作成だけでは通知は送られません。</p><div className="action-buttons"><button className="quiet-button" disabled={actions.busy} onClick={() => void reissue(link)}>リンクを再発行</button><button className="text-button" disabled={actions.busy} onClick={() => void withdraw(link)}>依頼を取り消す</button></div></div> : <p className="cancellation-note">{link.cancelledReason === 'declined' ? '相手が依頼を見送りました。' : link.cancelledReason === 'expired' ? '受諾期限を過ぎました。' : '依頼を取り消しました。'}支払確保を解除しました。</p>}
      </article>)}</div> : <p className="empty-invitations">受諾待ちの依頼はありません。</p>}</>}
  </section>;
}

export function RequestLinkLanding({ token, options, initialError }: { token: string; options: AuthOptions; initialError: string }) {
  const [link, setLink] = useState<RequestLinkView | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [authenticate, setAuthenticate] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const actions = useLinkActions();
  async function load() {
    setLink(null);
    const account = await api<IdentitySession | null>('/auth/identity');
    setIdentity(account);
    setLink(await api<RequestLinkView>('/link', undefined, undefined, undefined, token));
    setReady(true);
  }
  useEffect(() => { void actions.run(load); }, [token]);
  async function accept() {
    if (!identity) { setAuthenticate(true); return; }
    await actions.run(async () => {
      setLink(await actions.mutate<RequestLinkView>('/link/accept', { agreeToRules: agreed }, token));
      setIdentity(await api<IdentitySession>('/auth/identity'));
    });
  }
  async function decline() {
    if (!window.confirm('この依頼を見送りますか？リンクを無効にし、支払確保を解除します。')) return;
    await actions.run(async () => {
      await actions.mutate('/link/decline', {}, token);
      setLink(null); setDeclined(true);
    });
  }
  return <>
    <div className="demo-banner"><span className="demo-mark">DEMO</span>決済は体験用 · 実際の請求は発生しません</div>
    <header className="header shell invitation-header"><a className="wordmark" href="/">commission<span>↗</span></a><span>あなたに届いた依頼</span></header>
    <main className="shell invitation-landing"><div className="invitation-intro"><p className="eyebrow">SOMETHING TO CREATE</p><h1>あなたの創作に、<br />届いた依頼。</h1><p>内容と金額、期限を確かめて。<br />受けるかどうかは、あなたが選べます。</p><p className="private-link-note">このリンクはあなた宛てのものです。<br />ほかの人への共有はお控えください。</p></div>
      <div className="invitation-reader">
        {initialError && <div className="message error" role="alert">{initialError}</div>}
        {actions.error && <div className="message error" role="alert">{actions.error} <button disabled={actions.busy} onClick={() => void actions.run(load)}>再確認</button></div>}
        {!ready && !actions.error && <p className="loading" role="status">依頼を開いています…</p>}
        {declined && <div className="request-detail" role="status"><h2>依頼を見送りました</h2><p className="account-copy">支払確保を解除しました。ご確認ありがとうございました。</p><a href="/">ホームへ</a></div>}
        {link && <article className="request-detail" aria-label="届いた依頼">
          <div className="detail-heading"><span className="eyebrow">REQUEST DETAILS</span><span className="status"><i />{link.state === 'accepted' ? '受諾済み' : '受諾待ち'}</span></div>
          <h2>依頼の内容</h2><p className="detail-parties">{link.clientName}からの依頼</p><LinkFacts link={link} />
          {link.state === 'pending' && <div className="detail-actions"><p>見積もり・打ち合わせ・リテイク要求はありません。納品期限はリンクの作成日から数え、受諾しても延びません。</p>
            {identity ? <><div className="link-recipient-account"><span><strong>{identity.account.name}</strong>として受け取ります。</span><button className="text-button" disabled={actions.busy} onClick={() => void actions.run(async () => { await api('/auth/logout', {}); setIdentity(null); setAgreed(false); setAuthenticate(true); })}>別のアカウントを使う</button></div><label className="checkbox-line invitation-agreement"><input type="checkbox" checked={agreed} disabled={actions.busy} onChange={(event) => setAgreed(event.target.checked)} /><span>依頼のルールを確認し、この内容・金額・期限で受けることに同意します。</span></label><button className="primary" disabled={actions.busy || !agreed} onClick={() => void accept()}>この依頼を受ける<Arrow /></button></> : authenticate ? <section className="link-registration" aria-label="受け取るアカウント"><h3>受け取るアカウント</h3><p className="hint">登録・ログインのあと、受諾を確定できます。</p>{options.localLogin ? <LocalAccountForm onChange={load} /> : options.xLogin ? <XLoginButton /> : <p>現在、登録・ログインを利用できません。</p>}</section> : <><p>内容の確認・辞退には登録不要です。受けるときに登録・ログインします。</p><button className="primary" disabled={actions.busy} onClick={() => void accept()}>受諾へ進む<Arrow /></button></>}
            <button className="text-button decline-link" disabled={actions.busy} onClick={() => void decline()}>この依頼を見送る</button>
          </div>}
          {link.requestId && <div className="detail-actions"><p>依頼を受け取りました。支払状況と納品期限を確認して、制作を進めてください。</p><a className="primary" href={`/#request=${link.requestId}`}>依頼一覧へ<Arrow /></a></div>}
        </article>}
        {actions.error && !link && <p className="hint"><a href="/">登録済みの方は、ログインして依頼一覧を確認できます。</a></p>}
      </div>
    </main><footer className="footer shell"><span className="footer-brand">commission</span><span>つくる人の自由を、楽しみに。</span></footer>
  </>;
}
