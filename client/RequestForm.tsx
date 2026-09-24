import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { LinkDelivery, RequestLinkInput, Visibility } from '../src/shared';
import { Arrow } from './ui';
import { number, visibilityLabels, yen } from './format';
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
  const [delivery, setDelivery] = useState<LinkDelivery>('self');
  const [agreed, setAgreed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const byMail = delivery === 'email';
  const choices: [Visibility, string][] = [
    ['public', '本文・作品・自分の名前を公開'],
    ...(byMail
      ? [['anonymous', '本文と作品を公開。名前は相手にも非表示'] as [Visibility, string]]
      : []),
    ['hidden', '作品ページに載せない'],
  ];
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [brief, reviewing]);
  useEffect(() => {
    if (reviewing) heading.current?.focus();
  }, [reviewing]);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!reviewing) {
      if (!brief.trim()) {
        textarea.current?.setCustomValidity('内容を入力してください。');
        textarea.current?.reportValidity();
        return;
      }
      setBrief(brief.trim());
      setAgreed(false);
      setReviewing(true);
      return;
    }
    await submit({
      brief,
      amount: Number(amount),
      visibility,
      agreeToRules: agreed,
      delivery,
      ...(byMail ? { recipientEmail: recipientEmail.trim() } : {}),
    });
  }
  return (
    <form className="request-form" onSubmit={(event) => void onSubmit(event)}>
      <h1 className="compose-heading" ref={heading} tabIndex={-1}>
        {reviewing ? '内容の確認' : 'お願いを書く'}
      </h1>
      <fieldset key={reviewing ? 'review' : 'edit'} disabled={busy} className="form-fields">
        {reviewing ? (
          <>
            <p className="review-brief">{brief}</p>
            <dl className="detail-facts review-facts">
              <div>
                <dt>金額</dt>
                <dd>{yen(Number(amount))}</dd>
              </div>
              <div>
                <dt>公開設定</dt>
                <dd>{visibilityLabels[visibility]}</dd>
              </div>
              <div className="review-recipient">
                <dt>{byMail ? '宛先' : '送り方'}</dt>
                <dd>{byMail ? recipientEmail.trim() : 'リンクを自分で共有'}</dd>
              </div>
            </dl>
            <div className="review-conditions">
              <p>{choices.find(([value]) => value === visibility)?.[1]}</p>
              {visibility === 'hidden' && (
                <p>
                  作り手によるSNS等での作品発表は制限しません。秘密保持や権利譲渡を意味しません。
                </p>
              )}
              <p>
                受諾期限は作成から{terms.acceptanceDays}日、納品期限は作成から{terms.deliveryDays}
                日です。
              </p>
              <p>表現や仕上がりは作り手に任せます。見積もり・打ち合わせ・修正依頼はできません。</p>
              <p>
                支払いは作成時に仮押さえし、受諾時に確定します。受諾前の取消・辞退・期限切れでは仮押さえを解除し、受諾後の中止・納品期限切れでは返金します。
              </p>
              <p className="hint">試用版のため、実際の支払いは発生しません。</p>
            </div>
            <label className="checkbox-line review-agreement">
              <input
                type="checkbox"
                required
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>内容・金額・条件を確認しました</span>
            </label>
            <div className="submit-row">
              <button
                className="quiet-button"
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  setReviewing(false);
                  setAgreed(false);
                  requestAnimationFrame(() => textarea.current?.focus());
                }}
              >
                編集に戻る
              </button>
              <button className="primary" type="submit" disabled={busy || !agreed}>
                {busy ? '処理しています…' : byMail ? 'メールで送る' : 'リンクを作成'}
                <Arrow />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="brief">内容</label>
              <textarea
                ref={textarea}
                id="brief"
                value={brief}
                onChange={(event) => {
                  event.target.setCustomValidity('');
                  setBrief(event.target.value);
                }}
                required
                maxLength={limits.brief}
                rows={4}
                aria-describedby="brief-count"
              />
              <div className="field-meta">
                <span id="brief-count">
                  {number.format(brief.length)} / {number.format(limits.brief)}
                </span>
              </div>
            </div>
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
            <fieldset className="field">
              <legend>送り方</legend>
              <div className="delivery-options">
                {(
                  [
                    ['self', 'リンク'],
                    ['email', 'メール'],
                  ] as const
                ).map(([value, title]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="delivery"
                      value={value}
                      checked={delivery === value}
                      onChange={() => {
                        setDelivery(value);
                        if (value === 'self' && visibility === 'anonymous') setVisibility('public');
                      }}
                    />
                    {title}
                  </label>
                ))}
              </div>
              {byMail ? (
                <div className="recipient-field">
                  <label htmlFor="recipient-email">宛先のメールアドレス</label>
                  <input
                    id="recipient-email"
                    className="text-input"
                    type="email"
                    value={recipientEmail}
                    onChange={(event) => setRecipientEmail(event.target.value)}
                    required
                    maxLength={254}
                    autoComplete="off"
                    aria-describedby="recipient-hint"
                  />
                  <p className="hint" id="recipient-hint">
                    宛先のアドレスでログインした人だけが開けます。
                  </p>
                </div>
              ) : (
                <p className="hint">リンクを知っている人が開けます。相手だけに共有してください。</p>
              )}
            </fieldset>
            <fieldset className="field visibility-options">
              <legend>公開設定</legend>
              <div className="choice-grid">
                {choices.map(([value, description]) => (
                  <label className={`choice ${visibility === value ? 'checked' : ''}`} key={value}>
                    <input
                      type="radio"
                      name="visibility"
                      value={value}
                      checked={visibility === value}
                      onChange={() => setVisibility(value)}
                    />
                    <span className="choice-title">{visibilityLabels[value]}</span>
                    <span className="choice-description">{description}</span>
                  </label>
                ))}
              </div>
              {visibility === 'hidden' && (
                <p className="hint">
                  作り手によるSNS等での作品発表は制限しません。秘密保持や権利譲渡を意味しません。
                </p>
              )}
            </fieldset>
            <div className="submit-row">
              <button className="primary" type="submit">
                確認へ <Arrow />
              </button>
            </div>
          </>
        )}
      </fieldset>
    </form>
  );
}
