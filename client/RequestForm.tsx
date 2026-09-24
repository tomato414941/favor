import { useState, type FormEvent } from 'react';
import '@fontsource/newsreader/500-italic.css';
import type { LinkDelivery, RequestLinkInput, Visibility } from '../src/shared';
import { Arrow } from './ui';
import './RequestForm.css';

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
    ['public', '公開', '本文・作品・自分の名前を公開'],
    ...(byMail
      ? [
          ['anonymous', '匿名', '本文と作品を公開。名前は相手にも非表示'] as [
            Visibility,
            string,
            string,
          ],
        ]
      : []),
    ['hidden', '非表示', '作品ページに載せない'],
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
      <h1 className="compose-heading">お願いを書く</h1>
      <fieldset disabled={busy} className="form-fields">
        <div className="compose-fields">
          <div className="letter-editor">
            <label htmlFor="brief">お願いしたいこと</label>
            <textarea
              id="brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              required
              maxLength={limits.brief}
              rows={10}
              aria-describedby="brief-count"
            />
            <span className="letter-count" id="brief-count">
              {number.format(brief.length)} / {number.format(limits.brief)}
            </span>
          </div>
          <div className="compose-options">
            <div className="field">
              <div className="label-row">
                <label htmlFor="recipient-email">宛先のメールアドレス</label>
                <span className="optional-label">任意</span>
              </div>
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
                空欄ならリンクを自分で共有
              </p>
            </div>
            {recipientEmail.trim() !== '' && (
              <fieldset className="field visibility-options">
                <legend>届け方</legend>
                <div className="choice-grid">
                  {(
                    [
                      ['email', 'メールで送る', '宛先のアドレスでログインして開きます'],
                      ['self', 'リンクを渡す', 'DMなどで自分で共有します'],
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
            <div className="field">
              <label htmlFor="amount">金額</label>
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
                最低 {yen(terms.minimumAmount)}
              </p>
            </div>
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
          </div>
        </div>
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
