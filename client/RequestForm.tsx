import { useState, type FormEvent } from 'react';
import type { CreatorView, RequestInput, SessionView, Visibility } from '../src/shared';
import { Arrow } from './ui';

export interface RequestFormSettings {
  creator: CreatorView;
  limits: { brief: number; files: number; uploadBytes: number; maximumAmount: number };
}
const number = new Intl.NumberFormat('ja-JP');
const yen = (value: number) => `¥${number.format(value)}`;

export function RequestForm({ settings: { creator, limits }, session, busy, submit, invitation }: {
  settings: RequestFormSettings; session: SessionView; busy: boolean; submit: (input: RequestInput) => Promise<void>;
  invitation?: { handle: string; changeHandle: (handle: string) => void; demo: boolean };
}) {
  const [brief, setBrief] = useState('');
  const [amount, setAmount] = useState(String(creator.recommendedAmount));
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'points'>('card');
  const [nsfw, setNsfw] = useState(false);
  const [agreed, setAgreed] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit({ creatorId: creator.id, brief, amount: Number(amount), visibility, paymentMethod: invitation ? 'card' : paymentMethod, nsfw, agreeToRules: agreed });
  }
  return <form className="request-form" onSubmit={(event) => void onSubmit(event)}>
    <div className="form-heading"><span className="eyebrow">{invitation ? 'NEW INVITATION' : 'NEW REQUEST'}</span><h2>{invitation ? '招待リンクを作成' : '依頼を送る'}</h2><p>一度のメッセージに、お願いしたいことをまとめて。</p></div>
    <fieldset disabled={busy} className="form-fields">
      {invitation && <div className="field"><label htmlFor="recipient-handle">{invitation.demo ? '相手のSNSアカウント' : '相手のXアカウント'}</label><input id="recipient-handle" className="text-input" value={invitation.handle} onChange={(event) => invitation.changeHandle(event.target.value)} maxLength={100} required autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder={invitation.demo ? '@mio_demo' : '@username または https://x.com/username'} aria-describedby="recipient-hint" /><p className="hint" id="recipient-hint">{invitation.demo ? '体験用の宛先：@mio_demo（澪）・@sora_demo（空）' : '表示名ではなく、@から始まるユーザー名かプロフィールURLを指定してください。'}</p></div>}
      <div className="field"><div className="label-row"><label htmlFor="brief">依頼内容</label><span className="required-label">必須</span></div><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} required maxLength={limits.brief} rows={7} placeholder="描いてほしい風景や、聴いてみたい言葉。好きなところや参考資料のURLも、こちらに。" aria-describedby="brief-hint brief-count" /><div className="field-meta"><span id="brief-hint">送信後の打ち合わせやリテイク要求はできません。</span><span id="brief-count">{number.format(brief.length)} / {number.format(limits.brief)}</span></div></div>
      <div className="field"><label htmlFor="amount">依頼金額</label><div className="amount-row"><div className="amount-input"><span aria-hidden="true">¥</span><input id="amount" type="number" inputMode="numeric" min={creator.minimumAmount} max={limits.maximumAmount} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} required aria-describedby="amount-hint" /></div><button type="button" className="text-button" onClick={() => setAmount(String(creator.recommendedAmount))}>推奨額にする</button></div><p className="hint" id="amount-hint">最低 {yen(creator.minimumAmount)} · 金額は第三者には公開されません。</p></div>
      <fieldset className="field visibility-options"><legend>公開範囲</legend><div className="choice-grid">
        {([
          ['public', '公開', '依頼者名・依頼文・作品のプレビューを公開'],
          ['anonymous', '匿名', '依頼文・プレビューを公開。作り手にも名前を知らせない'],
          ['hidden', '非表示', '依頼文・作品をサービス内で一般公開しない'],
        ] as const).map(([value, title, description]) => <label className={`choice ${visibility === value ? 'checked' : ''}`} key={value}><input type="radio" name="visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} /><span className="choice-title">{title}</span><span className="choice-description">{description}</span></label>)}
      </div><p className="hint">非表示でも、作り手によるSNS等での作品発表は制限しません。秘密保持や権利譲渡を意味しません。</p></fieldset>
      {invitation && <p className="invitation-privacy-note">公開・匿名を選んでも、招待中の依頼文や金額は第三者に表示されません。</p>}
      {invitation && visibility === 'anonymous' && <p className="invitation-warning">あなたのSNSからリンクを送ると、相手にアカウントが伝わります。サービス内の匿名表示とは別です。</p>}
      <label className="checkbox-line"><input type="checkbox" checked={nsfw} onChange={(event) => setNsfw(event.target.checked)} /><span>成人向けなど、閲覧に注意が必要な内容を含む</span></label>
      <fieldset className="field payment-options"><legend>支払方法</legend><div className="payment-choices"><label className={paymentMethod === 'card' ? 'checked' : ''}><input type="radio" name="payment" checked={paymentMethod === 'card'} onChange={() => setPaymentMethod('card')} /><span>カード<span className="payment-subtitle">体験用</span></span></label>{!invitation && <label className={paymentMethod === 'points' ? 'checked' : ''}><input type="radio" name="payment" checked={paymentMethod === 'points'} onChange={() => setPaymentMethod('points')} /><span>ポイント<span className="payment-subtitle">利用可能 {number.format(session.pointsAvailable)} pt</span></span></label>}</div>
        <p className="hint">{invitation ? 'リンク作成時に利用枠を確保し、相手の受諾時に請求が確定します。体験用のため、カード情報の入力や実際の請求はありません。' : paymentMethod === 'card' ? '送信時に利用枠を確保し、承認時に請求が確定します。体験用のため、カード情報の入力や実際の請求はありません。' : 'ポイントは事前にチャージして使うサービス内残高です。送信時に代金分を確保し、承認時に差し引きます。ここでは体験用の残高を使います。'}</p>
        {paymentMethod === 'points' && <p className="wallet-summary">残高 {number.format(session.pointsBalance)} pt · 確保中 {number.format(session.pointsBalance - session.pointsAvailable)} pt</p>}
      </fieldset>
      <div className="agreement"><label className="checkbox-line"><input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>見積もり・打ち合わせ・リテイク要求をせず、表現や仕上がりを作り手に任せることに同意します。</span></label><p>{invitation ? '受諾前の取消・辞退・期限切れでは支払確保を解除します。受諾後の納品期限切れ・ギブアップでは返金します。' : '承認前の取消・期限切れでは支払確保を解除します。承認後の納品期限切れ・ギブアップでは返金またはポイント返還となります。'}</p></div>
      <div className="submit-row"><span>承認・納品の期限は<br />{invitation ? '招待リンクの作成日' : '依頼の送信日'}から数えます。</span><button className="primary" type="submit" disabled={busy}>{busy ? '処理しています…' : invitation ? '支払いを確保してリンク作成' : '支払いを確保して送信'}<Arrow /></button></div>
    </fieldset>
  </form>;
}
