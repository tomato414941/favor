import { useEffect, useRef, useState } from 'react';
import type {
  AuthOptions,
  IdentitySession,
  RequestLinkInput,
  RequestLinkResult,
  RequestLinkView,
} from '../src/shared';
import { paymentLabels } from '../src/shared';
import { api } from './api';
import { EmailLoginForm, XLoginButton } from './Auth';
import { RequestForm, type RequestFormSettings } from './RequestForm';
import { Arrow, Link } from './ui';

import { yen, date, visibilityLabels } from './format';

function useMutationKeys() {
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  return async function mutate<T>(path: string, body: unknown = {}, token?: string): Promise<T> {
    const payload = JSON.stringify({ body, token });
    let attempt = keys.current.get(path);
    if (!attempt || attempt.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      keys.current.set(path, attempt);
    }
    const result = await api<T>(path, { body, key: attempt.key, linkToken: token });
    keys.current.delete(path);
    return result;
  };
}

function useLinkActions() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mutate = useMutationKeys();
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作を完了できませんでした。');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, mutate };
}

function LinkFacts({ link }: { link: RequestLinkView }) {
  return (
    <>
      <div className="brief-block">
        <div className="brief-label">依頼内容</div>
        <p>{link.brief}</p>
      </div>
      <dl className="detail-facts">
        <div>
          <dt>依頼金額</dt>
          <dd>{yen(link.amount)}</dd>
        </div>
        <div>
          <dt>納品後の公開範囲</dt>
          <dd>{visibilityLabels[link.visibility]}</dd>
        </div>
        <div>
          <dt>作成日時</dt>
          <dd>{date(link.createdAt)}</dd>
        </div>
        <div>
          <dt>受諾期限</dt>
          <dd>{date(link.expiresAt)}</dd>
        </div>
        <div>
          <dt>納品期限</dt>
          <dd>{date(link.deliverBy)}</dd>
        </div>
        <div>
          <dt>支払い</dt>
          <dd>カード · {paymentLabels[link.paymentState]}</dd>
        </div>
      </dl>
    </>
  );
}

export function RequestLinks({
  settings,
  mode,
  links,
  busy,
  run,
  notify,
  onChange,
  onCreated,
}: {
  settings: RequestFormSettings;
  mode: 'compose' | 'list' | 'hidden';
  links: RequestLinkView[];
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
  onChange: (link: RequestLinkView) => void;
  onCreated: () => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const mutate = useMutationKeys();
  function save(result: RequestLinkResult) {
    onChange(result.link);
    setUrls((current) => {
      const next = { ...current };
      if (result.token) next[result.link.id] = `${window.location.origin}/link#${result.token}`;
      else delete next[result.link.id];
      return next;
    });
  }
  async function submit(input: RequestLinkInput) {
    await run(async () => {
      const result = await mutate<RequestLinkResult>('/links', input);
      save(result);
      notify(
        result.token
          ? '依頼リンクを作成しました。依頼する相手だけに共有してください。'
          : '作成済みの依頼を確認しました。共有するリンクを再発行してください。',
      );
      onCreated();
    });
  }
  async function reissue(link: RequestLinkView) {
    if (!window.confirm('古いリンクを無効にして再発行しますか？受諾期限・納品期限は変わりません。'))
      return;
    await run(async () => {
      setUrls((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
      const result = await mutate<RequestLinkResult>(`/links/${link.id}/reissue`);
      save(result);
      notify(
        result.token
          ? 'リンクを再発行しました。相手に新しいリンクを共有してください。'
          : '再発行済みのリンクを表示できません。もう一度再発行してください。',
      );
    });
  }
  async function withdraw(link: RequestLinkView) {
    if (!window.confirm('この依頼を取り消しますか？リンクを無効にし、支払確保を解除します。'))
      return;
    await run(async () => {
      onChange(await mutate<RequestLinkView>(`/links/${link.id}/withdraw`));
      setUrls((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
      notify('依頼を取り消し、支払確保を解除しました。');
    });
  }
  async function copy(url: string) {
    await run(async () => {
      if (!navigator.clipboard) throw new Error('リンク欄を選択してコピーしてください。');
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        throw new Error('コピーできませんでした。リンク欄を選択してコピーしてください。');
      }
      notify('依頼リンクをコピーしました。');
    });
  }
  if (mode === 'hidden') return null;
  if (mode === 'compose')
    return (
      <section className="request-links-section">
        <div className="compose-layout">
          <RequestForm settings={settings} busy={busy} submit={submit} />
        </div>
      </section>
    );
  if (!links.length) return null;
  return (
    <div className="request-link-list">
      {links.map((link) => (
        <article className="request-detail request-link-card" key={link.id} aria-label="依頼リンク">
          <div className="detail-heading">
            <span className="eyebrow">共有した依頼</span>
            <span className={`status status-${link.state === 'pending' ? 'pending' : 'cancelled'}`}>
              <i />
              {link.state === 'pending' ? '受諾待ち' : '受付終了'}
            </span>
          </div>
          <h2>
            {link.state === 'pending' ? '相手の受諾を待っています' : 'この依頼の受付は終了しました'}
          </h2>
          <LinkFacts link={link} />
          {link.state === 'pending' ? (
            <div className="request-link-share">
              {urls[link.id] ? (
                <>
                  <label htmlFor={`link-${link.id}`}>依頼リンク</label>
                  <div className="link-row">
                    <input
                      id={`link-${link.id}`}
                      className="text-input"
                      value={urls[link.id]}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => void copy(urls[link.id]!)}
                    >
                      コピー
                    </button>
                  </div>
                </>
              ) : (
                <p className="hint">共有するリンクが必要な場合は再発行してください。</p>
              )}
              <p className="hint">
                相手だけに共有してください。リンクの作成だけでは通知は送られません。
              </p>
              <div className="action-buttons">
                <button className="quiet-button" disabled={busy} onClick={() => void reissue(link)}>
                  リンクを再発行
                </button>
                <button className="text-button" disabled={busy} onClick={() => void withdraw(link)}>
                  依頼を取り消す
                </button>
              </div>
            </div>
          ) : (
            <p className="cancellation-note">
              {link.cancelledReason === 'declined'
                ? '相手が依頼を見送りました。'
                : link.cancelledReason === 'expired'
                  ? '受諾期限を過ぎました。'
                  : '依頼を取り消しました。'}
              支払確保を解除しました。
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

export function RequestLinkLanding({
  token,
  options,
  initialError,
}: {
  token: string;
  options: AuthOptions;
  initialError: string;
}) {
  const [link, setLink] = useState<RequestLinkView | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [authenticate, setAuthenticate] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [confirmingDecline, setConfirmingDecline] = useState(false);
  const declineButton = useRef<HTMLButtonElement>(null);
  const actions = useLinkActions();
  async function load() {
    setLink(null);
    const account = await api<IdentitySession | null>('/auth/identity');
    setIdentity(account);
    setLink(await api<RequestLinkView>('/links/by-token', { linkToken: token }));
    setReady(true);
  }
  useEffect(() => {
    void actions.run(load);
  }, [token]);
  async function accept() {
    if (!identity) {
      setAuthenticate(true);
      return;
    }
    await actions.run(async () => {
      setLink(
        await actions.mutate<RequestLinkView>(
          '/links/by-token/accept',
          { agreeToRules: agreed },
          token,
        ),
      );
      setIdentity(await api<IdentitySession>('/auth/identity'));
    });
  }
  async function decline() {
    await actions.run(async () => {
      await actions.mutate('/links/by-token/decline', {}, token);
      setLink(null);
      setDeclined(true);
    });
  }
  function cancelDecline() {
    setConfirmingDecline(false);
    requestAnimationFrame(() => declineButton.current?.focus());
  }
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <header className="header shell request-link-header">
        <a className="wordmark" href="/">
          commission
        </a>
      </header>
      <main className="shell request-link-landing">
        <div className="request-link-reader">
          {initialError && (
            <div className="message error" role="alert">
              {initialError}
            </div>
          )}
          {actions.error && (
            <div className="message error" role="alert">
              {actions.error}{' '}
              <button disabled={actions.busy} onClick={() => void actions.run(load)}>
                再確認
              </button>
            </div>
          )}
          {!ready && !actions.error && (
            <p className="loading" role="status">
              依頼を開いています…
            </p>
          )}
          {declined && (
            <div className="request-detail" role="status">
              <h2>依頼を見送りました</h2>
              <p className="account-copy">支払確保を解除しました。ご確認ありがとうございました。</p>
              <a href="/">ホームへ</a>
            </div>
          )}
          {link && (
            <article className="request-detail" aria-label="依頼">
              <div className="detail-heading">
                <h1>依頼</h1>
                <span className="status">
                  <i />
                  {link.state === 'accepted' ? '受諾済み' : '受諾待ち'}
                </span>
              </div>
              <p className="detail-parties">{link.clientName}からの依頼</p>
              <LinkFacts link={link} />
              {link.state === 'pending' && (
                <div className="detail-actions">
                  {identity ? (
                    <>
                      <div className="link-recipient-account">
                        <span>
                          <strong>{identity.email ?? identity.account.name}</strong>
                          として受け取ります。
                        </span>
                        <button
                          className="text-button"
                          disabled={actions.busy}
                          onClick={() =>
                            void actions.run(async () => {
                              await api('/auth/logout', { body: {} });
                              setIdentity(null);
                              setAgreed(false);
                              setAuthenticate(true);
                            })
                          }
                        >
                          別のアカウントを使う
                        </button>
                      </div>
                      <label className="checkbox-line request-link-agreement">
                        <input
                          type="checkbox"
                          checked={agreed}
                          disabled={actions.busy}
                          onChange={(event) => setAgreed(event.target.checked)}
                        />
                        <span>内容・金額・期限を確認しました</span>
                      </label>
                      <button
                        className="primary"
                        disabled={actions.busy || !agreed}
                        onClick={() => void accept()}
                      >
                        この依頼を受ける
                        <Arrow />
                      </button>
                    </>
                  ) : authenticate ? (
                    <section className="link-registration" aria-label="受け取るアカウント">
                      <h3>受け取るアカウント</h3>
                      {options.emailLogin ? (
                        <EmailLoginForm onChange={load} />
                      ) : options.xLogin ? (
                        <XLoginButton />
                      ) : (
                        <p>現在、登録・ログインを利用できません。</p>
                      )}
                    </section>
                  ) : (
                    <button
                      className="primary"
                      disabled={actions.busy}
                      onClick={() => void accept()}
                    >
                      受諾へ進む
                      <Arrow />
                    </button>
                  )}
                  {confirmingDecline ? (
                    <div
                      className="decline-confirmation"
                      role="group"
                      aria-labelledby="decline-question"
                      aria-busy={actions.busy}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !actions.busy) {
                          event.preventDefault();
                          cancelDecline();
                        }
                      }}
                    >
                      <p id="decline-question">この依頼を見送りますか？</p>
                      <div className="action-buttons">
                        <button
                          className="quiet-button"
                          disabled={actions.busy}
                          autoFocus
                          onClick={cancelDecline}
                        >
                          戻る
                        </button>
                        <button
                          className="quiet-button confirm-decline"
                          disabled={actions.busy}
                          onClick={() => void decline()}
                        >
                          見送る
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      ref={declineButton}
                      className="text-button decline-link"
                      disabled={actions.busy}
                      onClick={() => setConfirmingDecline(true)}
                    >
                      この依頼を見送る
                    </button>
                  )}
                </div>
              )}
              {link.requestId && (
                <div className="detail-actions">
                  <Link className="primary" href={`/requests/${link.requestId}`}>
                    受けた依頼へ
                    <Arrow />
                  </Link>
                </div>
              )}
            </article>
          )}
          {link && <p className="private-link-note">このリンクは第三者に共有しないでください</p>}
          {actions.error && !link && (
            <p className="hint">
              <a href="/">登録済みの方は、ログインして受けた依頼を確認できます。</a>
            </p>
          )}
        </div>
      </main>
      <footer className="footer shell">
        <span className="footer-brand">commission</span>
      </footer>
    </>
  );
}
