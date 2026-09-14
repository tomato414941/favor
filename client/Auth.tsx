import { useState } from 'react';
import type { AuthOptions, IdentitySession } from '../src/shared';
import { api } from './api';
import { Arrow } from './ui';

const returnKey = 'commission.x-return';
const validReturn = (hash: string) => /^(?:#invite=[A-Za-z0-9_-]{43}|#request=[A-Za-z0-9_-]{1,100})$/.test(hash) ? hash : '';

export async function beginXLogin(returnTo = window.location.hash) {
  try {
    // Check storage before leaving. Invitation tokens never enter the OAuth state or a server URL.
    sessionStorage.setItem(returnKey, JSON.stringify({ hash: validReturn(returnTo), at: Date.now() }));
  } catch { throw new Error('このブラウザーではログイン先から戻れません。サイトのデータ保存を許可して、もう一度お試しください。'); }
  try {
    const { url } = await api<{ url: string }>('/auth/x/start', {});
    const target = new URL(url);
    if (target.origin !== 'https://x.com' || target.pathname !== '/i/oauth2/authorize') throw new Error('ログイン先を確認できませんでした。');
    sessionStorage.setItem(returnKey, JSON.stringify({ hash: validReturn(returnTo), at: Date.now(), state: target.searchParams.get('state') }));
    window.location.assign(url);
  } catch (error) { sessionStorage.removeItem(returnKey); throw error; }
}

export function restoreXReturn(): { hash: string; error: string } {
  const current = new URLSearchParams(window.location.hash.slice(1));
  const outcome = current.get('auth');
  if (!outcome) return { hash: window.location.hash, error: '' };
  let hash = '';
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey) ?? 'null');
    if (saved && saved.state === current.get('flow')) {
      sessionStorage.removeItem(returnKey);
      if (typeof saved.at === 'number' && Date.now() - saved.at < 900_000 && typeof saved.hash === 'string') hash = validReturn(saved.hash);
    }
  } catch { /* A regular login remains usable when the return location cannot be restored. */ }
  const error = outcome === 'success' ? '' : outcome === 'cancelled' ? 'Xでの確認を中止しました。もう一度確認できます。'
    : outcome === 'expired' ? '確認の有効期限が切れました。もう一度Xでログインしてください。'
      : 'Xのアカウントを確認できませんでした。時間をおいてお試しください。';
  window.history.replaceState(null, '', `/${hash}`);
  return { hash, error };
}

export function XLoginButton({ label = 'Xでログイン', disabled = false }: { label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login() {
    setBusy(true); setError('');
    try { await beginXLogin(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログインを開始できませんでした。'); setBusy(false); }
  }
  return <div className="x-login-control"><button className="primary x-login-button" disabled={disabled || busy} onClick={() => void login()}>{busy ? 'Xを開いています…' : label}<Arrow /></button>{error && <p className="inline-error" role="alert">{error}</p>}</div>;
}

export function AccountEntry({ options, identity, onChange, initialError }: {
  options: AuthOptions; identity: IdentitySession | null; onChange: () => void; initialError: string;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function run(register: boolean) {
    setBusy(true); setError('');
    try { await api(register ? '/auth/register' : '/auth/logout', register ? { agreeToRules: agreed } : {}); onChange(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="demo-banner"><span className="demo-mark">DEMO</span>決済は体験用 · 実際の請求は発生しません</div>
    <header className="header shell invitation-header"><a className="wordmark" href="/">commission<span>↗</span></a><span>つくる人の自由を、楽しみに。</span></header>
    <main className="shell account-layout">
      <section className="account-intro"><p className="eyebrow">A LITTLE TRUST, A NEW CREATION</p><h1>好きな創作を、<br />その人の自由で。</h1><p>届けたい言葉と、応援の気持ちを。<br />あとは、作り手の感性におまかせ。</p><span className="account-signature" aria-hidden="true">Leave a little<br /><i>room for wonder.</i></span></section>
      <section className="account-panel" aria-label={identity ? 'サービスへの登録' : 'ログイン'}>
        <p className="eyebrow">{identity ? 'ONE ACCOUNT, BOTH SIDES' : 'WELCOME TO COMMISSION'}</p>
        <h2>{identity ? 'ここから、はじめよう。' : 'いつものアカウントで。'}</h2>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {identity ? <>
          <div className="registration-identity"><strong>{identity.account.name}</strong><span>@{identity.account.handle}</span><button className="text-button" disabled={busy} onClick={() => void run(false)}>別のアカウントを使う</button></div>
          <p className="account-copy">ひとつのアカウントで、依頼を送ることも、受け取ることもできます。</p>
          <ul className="registration-rules"><li>見積もり・打ち合わせ・リテイク要求は行いません。</li><li>作り手は受けたい依頼を選び、表現や仕上がりを自由に決めます。</li><li>承認・納品の期限は、依頼や招待の作成日から数えます。</li></ul>
          <p className="hint">XのユーザーID・表示名・ユーザー名を、ログインと招待先の確認に使用します。表示名は依頼者・作り手の名前として使われます。</p>
          <label className="checkbox-line registration-agreement"><input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} /><span>依頼のルールとアカウント情報の利用を確認し、サービスへの登録に同意します。</span></label>
          <button className="primary" disabled={!agreed || busy} onClick={() => void run(true)}>{busy ? '登録しています…' : '同意して登録する'}<Arrow /></button>
        </> : <>
          <p className="account-copy">Xでログインして、創作の依頼をはじめましょう。はじめての方は、アカウントの確認後に登録へ進めます。</p>
          {options.xLogin ? <XLoginButton /> : <p className="inline-error" role="status">現在、ログインを利用できません。時間をおいてお試しください。</p>}
          <p className="hint account-privacy">あなたの代わりに投稿・DMを送ることはありません。<br />Xのパスワードを、このサービスに入力する必要はありません。</p>
        </>}
      </section>
    </main>
    <footer className="footer shell"><span className="footer-brand">commission</span><span>つくる人の自由を、楽しみに。</span></footer>
  </>;
}
