import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useFetcher, useNavigate } from 'react-router';
import type { LinkDelivery, PaymentMode, RequestLinkResult, Visibility } from '../../src/shared';
import { useSite } from '../root';
import { Arrow, useOperationKey, type ActionFailure } from './ui';
import { number, visibilityLabels, yen } from './format';

export interface RequestFormSettings {
  paymentMode: PaymentMode;
  terms: {
    recommendedAmount: number;
    minimumAmount: number;
    acceptanceDays: number;
    deliveryDays: number;
  };
  limits: { brief: number; files: number; uploadBytes: number; maximumAmount: number };
}
type Created = ActionFailure & Partial<RequestLinkResult>;

/** Writes a request in two steps: the text and terms, then a review before it is sent. */
export function RequestForm({
  settings: { terms, limits, paymentMode },
}: {
  settings: RequestFormSettings;
}) {
  const fetcher = useFetcher<Created>();
  const { hasPublicProfile } = useSite();
  const navigate = useNavigate();
  const operation = useOperationKey();
  const [brief, setBrief] = useState('');
  const [amount, setAmount] = useState(String(terms.recommendedAmount));
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [delivery, setDelivery] = useState<LinkDelivery>('self');
  const [agreed, setAgreed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = fetcher.state !== 'idle';
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
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.link) return;
    const { link, token, checkoutUrl } = fetcher.data;
    operation.done();
    if (checkoutUrl) {
      window.location.assign(checkoutUrl);
      return;
    }
    const notice =
      link.delivery === 'email'
        ? `${link.recipientEmail ?? '相手'}へ送りました。`
        : token
          ? 'リンクを作成しました。'
          : '作成済みの依頼を確認しました。リンクを再発行してください。';
    void navigate(`/me/links/${link.id}`, { state: { token, notice } });
  }, [fetcher.state, fetcher.data]);
  const payload = {
    brief,
    amount,
    visibility,
    delivery,
    recipientEmail: byMail ? recipientEmail.trim() : '',
  };
  return (
    <fetcher.Form
      className="request-form"
      method="post"
      action="/me/new"
      onSubmit={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        if (reviewing) return;
        event.preventDefault();
        if (!brief.trim()) {
          textarea.current?.setCustomValidity('内容を入力してください。');
          textarea.current?.reportValidity();
          return;
        }
        setBrief(brief.trim());
        setAgreed(false);
        setReviewing(true);
      }}
    >
      <h1 className="compose-heading" ref={heading} tabIndex={-1}>
        {reviewing ? '内容の確認' : 'お願いを書く'}
      </h1>
      {fetcher.data?.error && (
        <p className="message error" role="alert">
          {fetcher.data.error.message}
        </p>
      )}
      <fieldset key={reviewing ? 'review' : 'edit'} disabled={busy} className="form-fields">
        {reviewing ? (
          <>
            <input type="hidden" name="key" value={operation.keyFor(payload)} />
            <input type="hidden" name="brief" value={brief} />
            <input type="hidden" name="amount" value={amount} />
            <input type="hidden" name="visibility" value={visibility} />
            <input type="hidden" name="delivery" value={delivery} />
            {byMail && <input type="hidden" name="recipientEmail" value={recipientEmail.trim()} />}
            <p className="review-brief">{brief}</p>
            <dl className="detail-facts review-facts">
              <div className="amount-total">
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
                受諾は作成から{terms.acceptanceDays}日以内、納品は最長{terms.deliveryDays}
                日以内です。 カードの仮押さえ期限により短くなります。
              </p>
              <p>表現や仕上がりは作り手に任せます。見積もり・打ち合わせ・修正依頼はできません。</p>
              <p>
                作成時にカードの利用枠を仮押さえし、納品時に支払います。取消・辞退・中止・期限切れの場合は解除します。
              </p>
              {paymentMode !== 'stripe_live' && (
                <p className="hint">試用版のため、実際の支払いは発生しません。</p>
              )}
            </div>
            <label className="checkbox-line review-agreement">
              <input
                type="checkbox"
                name="agreeToRules"
                required
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>内容・金額・条件を確認しました</span>
            </label>
            {hasPublicProfile && (
              <p className="hint">
                <Link to="/terms" target="_blank" rel="noreferrer">
                  利用規約
                </Link>
                ・
                <Link to="/legal" target="_blank" rel="noreferrer">
                  取消・返金について
                </Link>
              </p>
            )}
            <div className="submit-row">
              <button
                className="quiet-button"
                type="button"
                onClick={() => {
                  setReviewing(false);
                  setAgreed(false);
                  requestAnimationFrame(() => textarea.current?.focus());
                }}
              >
                編集に戻る
              </button>
              <button className="primary" type="submit" disabled={busy || !agreed}>
                {busy
                  ? '処理しています…'
                  : paymentMode !== 'mock'
                    ? 'カード入力へ'
                    : byMail
                      ? 'メールで送る'
                      : 'リンクを作成'}
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
                      name="delivery-choice"
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
                      name="visibility-choice"
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
    </fetcher.Form>
  );
}
