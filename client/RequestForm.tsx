import { useState, type FormEvent } from 'react';
import type { LinkDelivery, RequestLinkInput, Visibility } from '../src/shared';
import { Arrow } from './ui';

export interface RequestFormSettings {
  terms: {
    recommendedAmount: number;
    minimumAmount: number;
    acceptanceDays: number;
    deliveryDays: number;
  };
  limits: { brief: number; files: number; uploadBytes: number; maximumAmount: number };
}
import { number, yen } from './format';

export function RequestForm({
  settings: { terms, limits },
  busy,
  submit,
}: {
  settings: RequestFormSettings;
  busy: boolean;
  submit: (input: RequestLinkInput) => Promise<void>;
}) {
  const [brief, setBrief] = useState('');
  const [amount, setAmount] = useState(String(terms.recommendedAmount));
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [delivery, setDelivery] = useState<LinkDelivery>('email');
  const [agreed, setAgreed] = useState(false);
  const byMail = recipientEmail.trim() !== '' && delivery === 'email';
  const choices: [Visibility, string, string][] = [
    ['public', '公開', '依頼文と作品を作品ページに載せ、依頼者名も表示する'],
    ...(byMail
      ? [
          ['anonymous', '匿名', '依頼文と作品を載せ、依頼者名は相手にも表示しない'] as [
            Visibility,
            string,
            string,
          ],
        ]
      : []),
    ['hidden', '非表示', '作品ページを作らない'],
  ];
  const chosen = visibility === 'anonymous' && !byMail ? 'public' : visibility;
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = recipientEmail.trim();
    await submit({
      brief,
      amount: Number(amount),
      visibility: chosen,
      agreeToRules: agreed,
      delivery: email ? delivery : 'self',
      ...(email ? { recipientEmail: email } : {}),
    });
  }
  return (
    <form className="request-form" onSubmit={(event) => void onSubmit(event)}>
      <div className="form-heading">
        <h2>依頼リンクを作成</h2>
      </div>
      <fieldset disabled={busy} className="form-fields">
        <div className="field">
          <div className="label-row">
            <label htmlFor="brief">依頼内容</label>
            <span className="required-label">必須</span>
          </div>
          <textarea
            id="brief"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            required
            maxLength={limits.brief}
            rows={7}
            placeholder="依頼したい作品、用途、参考資料のURLなどを記入してください。"
            aria-describedby="brief-hint brief-count"
          />
          <div className="field-meta">
            <span id="brief-hint">作成後の打ち合わせやリテイク要求はできません。</span>
            <span id="brief-count">
              {number.format(brief.length)} / {number.format(limits.brief)}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="amount">依頼金額</label>
          <div className="amount-input">
            <span aria-hidden="true">¥</span>
            <input
              id="amount"
              type="number"
              inputMode="numeric"
              min={terms.minimumAmount}
              max={limits.maximumAmount}
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
              aria-describedby="amount-hint"
            />
          </div>
          <p className="hint" id="amount-hint">
            最低 {yen(terms.minimumAmount)} · 金額は第三者には公開されません。
          </p>
        </div>
        <div className="field">
          <label htmlFor="recipient-email">相手のメールアドレス</label>
          <input
            id="recipient-email"
            className="text-input"
            type="email"
            value={recipientEmail}
            onChange={(event) => setRecipientEmail(event.target.value)}
            maxLength={254}
            autoComplete="off"
            aria-describedby="recipient-hint"
          />
          <p className="hint" id="recipient-hint">
            空のままなら、作成したリンクを自分で相手に渡します。
          </p>
        </div>
        {recipientEmail.trim() !== '' && (
          <fieldset className="field visibility-options">
            <legend>届け方</legend>
            <div className="choice-grid">
              {(
                [
                  [
                    'email',
                    'Favorがメールで送る',
                    '相手はそのメールアドレスでログインして開きます',
                  ],
                  ['self', '自分でリンクを渡す', 'リンクを受け取って、DMなどで相手に送ります'],
                ] as const
              ).map(([value, title, description]) => (
                <label className={`choice ${delivery === value ? 'checked' : ''}`} key={value}>
                  <input
                    type="radio"
                    name="delivery"
                    value={value}
                    checked={delivery === value}
                    onChange={() => setDelivery(value)}
                  />
                  <span className="choice-title">{title}</span>
                  <span className="choice-description">{description}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="field visibility-options">
          <legend>納品後の公開範囲</legend>
          <div className="choice-grid">
            {choices.map(([value, title, description]) => (
              <label className={`choice ${chosen === value ? 'checked' : ''}`} key={value}>
                <input
                  type="radio"
                  name="visibility"
                  value={value}
                  checked={chosen === value}
                  onChange={() => setVisibility(value)}
                />
                <span className="choice-title">{title}</span>
                <span className="choice-description">{description}</span>
              </label>
            ))}
          </div>
          <p className="hint">
            非表示でも、作り手によるSNS等での作品発表は制限しません。秘密保持や権利譲渡を意味しません。
          </p>
        </fieldset>
        <p className="payment-note">
          受諾期限は作成から{terms.acceptanceDays}日、納品期限は{terms.deliveryDays}日です。
          支払いはリンク作成時に確保し、相手の受諾時に確定します。
        </p>
        <div className="agreement">
          <label className="checkbox-line">
            <input
              type="checkbox"
              required
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>
              見積もり・打ち合わせ・リテイク要求をせず、表現や仕上がりを作り手に任せることに同意します。
            </span>
          </label>
          <p>
            受諾前の取消・辞退・期限切れでは支払確保を解除します。受諾後の納品期限切れ・ギブアップでは返金します。
          </p>
        </div>
        <div className="submit-row">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '処理しています…' : byMail ? 'メールで送る' : 'リンクを作成'}
            <Arrow />
          </button>
        </div>
      </fieldset>
    </form>
  );
}
