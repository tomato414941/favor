import { useEffect, useRef, useState } from 'react';
import { RecipientAccount } from './RecipientAccount';
import type {
  AuthOptions,
  IdentitySession,
  RequestLinkInput,
  RequestLinkResult,
  RequestLinkView,
} from '../src/shared';
import { paymentLabels } from '../src/shared';
import { api, ApiError } from './api';
import { SignInPanel } from './Auth';
import { RequestForm, type RequestFormSettings } from './RequestForm';
import { Arrow, ConfirmAction, Link } from './ui';

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
        <p>{link.brief}</p>
      </div>
      <dl className="detail-facts">
        <div>
          <dt>金額</dt>
          <dd>{yen(link.amount)}</dd>
        </div>
        <div>
          <dt>公開設定</dt>
          <dd>{visibilityLabels[link.visibility]}</dd>
        </div>
        <div>
          <dt>作成日時</dt>
          <dd>{date(link.createdAt)}</dd>
        </div>
        {link.state !== 'awaiting_payment' && (
          <>
            <div>
              <dt>受諾期限</dt>
              <dd>{date(link.expiresAt)}</dd>
            </div>
            <div>
              <dt>納品期限</dt>
              <dd>{date(link.deliverBy)}</dd>
            </div>
          </>
        )}
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
  linkId,
  links,
  busy,
  run,
  notify,
  onChange,
  onCreated,
}: {
  settings: RequestFormSettings;
  mode: 'compose' | 'detail' | 'hidden';
  linkId: string | null;
  links: RequestLinkView[];
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
  onChange: (link: RequestLinkView) => void;
  onCreated: (id: string) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const mutate = useMutationKeys();
  const returned = useRef<string | null>(null);
  useEffect(() => {
    if (
      mode !== 'detail' ||
      !linkId ||
      returned.current === linkId ||
      !links.some((link) => link.id === linkId)
    )
      return;
    if (new URLSearchParams(window.location.search).get('payment') !== 'return') return;
    returned.current = linkId;
    window.history.replaceState(null, '', window.location.pathname);
    void complete(linkId);
  }, [mode, linkId, links]);
  async function complete(id: string) {
    await run(async () => {
      const result = await mutate<RequestLinkResult>(`/links/${id}/complete-payment`);
      save(result);
      notify(result.link.delivery === 'email' ? 'メールで送りました。' : 'リンクを作成しました。');
    });
  }
  async function checkout(id: string) {
    await run(async () => {
      const result = await mutate<RequestLinkResult>(`/links/${id}/checkout`);
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else throw new Error('支払いを確認してください。');
    });
  }
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
      if (result.checkoutUrl) {
        onCreated(result.link.id);
        window.location.assign(result.checkoutUrl);
        return;
      }
      notify(
        result.link.delivery === 'email'
          ? `${result.link.recipientEmail ?? '相手'}へ送りました。`
          : result.token
            ? 'リンクを作成しました。'
            : '作成済みの依頼を確認しました。リンクを再発行してください。',
      );
      onCreated(result.link.id);
    });
  }
  async function reissue(link: RequestLinkView) {
    await run(async () => {
      setUrls((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
      const result = await mutate<RequestLinkResult>(`/links/${link.id}/reissue`);
      save(result);
      notify(
        result.link.delivery === 'email'
          ? '新しいリンクをメールで送り直しました。'
          : result.token
            ? 'リンクを再発行しました。'
            : '再発行済みのリンクを表示できません。もう一度再発行してください。',
      );
    });
  }
  async function withdraw(link: RequestLinkView) {
    await run(async () => {
      onChange(await mutate<RequestLinkView>(`/links/${link.id}/withdraw`));
      setUrls((current) => {
        const next = { ...current };
        delete next[link.id];
        return next;
      });
      notify('依頼を取り消しました。');
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
      notify('リンクをコピーしました。');
    });
  }
  if (mode === 'hidden') return null;
  if (mode === 'compose')
    return (
      <div className="compose-layout">
        <RequestForm settings={settings} busy={busy} submit={submit} />
      </div>
    );
  const link = links.find((item) => item.id === linkId);
  return (
    <div className="detail-page">
      <Link className="back-link" href="/me/sent">
        送った依頼へ
      </Link>
      {link ? (
        <article className="request-detail" key={link.id} aria-label="依頼リンク">
          <div className="detail-heading">
            <h1>{link.delivery === 'email' ? link.recipientEmail : 'リンクで共有'}</h1>
            <LinkStatus link={link} />
          </div>
          <LinkFacts link={link} />
          {link.state === 'awaiting_payment' ? (
            <div className="detail-actions">
              {link.paymentState === 'authorized' ? (
                <button className="primary" disabled={busy} onClick={() => void complete(link.id)}>
                  {link.delivery === 'email' ? 'メールで送る' : 'リンクを作成'}
                  <Arrow />
                </button>
              ) : (
                <>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void checkout(link.id)}
                  >
                    カード入力へ
                    <Arrow />
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void complete(link.id)}
                  >
                    入力済みの支払いを確認
                  </button>
                </>
              )}
              <ConfirmAction
                label="取り消す"
                question="この依頼を取り消しますか？"
                busy={busy}
                onConfirm={() => withdraw(link)}
              />
            </div>
          ) : link.state === 'pending' ? (
            <div className="request-link-share">
              {link.delivery === 'self' && (
                <>
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
                    リンクを知っている人が開けます。相手だけに共有してください。
                  </p>
                </>
              )}
              <div className="link-management">
                <ConfirmAction
                  label={link.delivery === 'email' ? 'メールを送り直す' : 'リンクを再発行'}
                  question={
                    link.delivery === 'email'
                      ? '新しいリンクをメールで送りますか？'
                      : 'リンクを再発行しますか？'
                  }
                  description={`${link.delivery === 'email' ? link.recipientEmail + 'へ送ります。' : ''}古いリンクは使えなくなります。期限は変わりません。`}
                  busy={busy}
                  onConfirm={() => reissue(link)}
                />
                <ConfirmAction
                  label="取り消す"
                  question="この依頼を取り消しますか？"
                  description="リンクを無効にし、支払確保を解除します。"
                  busy={busy}
                  onConfirm={() => withdraw(link)}
                />
              </div>
            </div>
          ) : link.requestId ? (
            <Link className="quiet-button" href={`/me/requests/${link.requestId}`}>
              依頼を開く
            </Link>
          ) : (
            <p className="cancellation-note">
              {link.cancelledReason === 'declined'
                ? '相手が依頼を見送りました。'
                : link.cancelledReason === 'expired'
                  ? '受諾期限を過ぎました。'
                  : link.cancelledReason === 'undeliverable'
                    ? 'メールを送信できませんでした。'
                    : link.cancelledReason === 'recipient_blocked'
                      ? '相手がメールでの依頼を受け取らない設定にしています。'
                      : '依頼を取り消しました。'}
              {link.paymentState === 'released'
                ? '仮押さえを解除しました。'
                : '仮押さえの解除を確認しています。'}
            </p>
          )}
        </article>
      ) : (
        <p className="empty-state">依頼が見つかりません</p>
      )}
    </div>
  );
}

export function LinkStatus({ link }: { link: RequestLinkView }) {
  return (
    <span className={`status status-${link.state}`}>
      {link.state === 'awaiting_payment'
        ? link.paymentState === 'authorized'
          ? '作成待ち'
          : 'カード入力待ち'
        : link.state === 'pending'
          ? '受諾待ち'
          : link.state === 'accepted'
            ? '受諾済み'
            : '受付終了'}
    </span>
  );
}

export function RequestLinkLanding({ token, options }: { token: string; options: AuthOptions }) {
  const [link, setLink] = useState<RequestLinkView | null>(null);
  const [identity, setIdentity] = useState<IdentitySession | null>(null);
  const [ready, setReady] = useState(false);
  const [authenticate, setAuthenticate] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [recipientReady, setRecipientReady] = useState(false);
  const actions = useLinkActions();
  async function load() {
    setLink(null);
    setLoginRequired(false);
    const account = await api<IdentitySession | null>('/auth/identity');
    setIdentity(account);
    try {
      const current = await api<RequestLinkView>('/links/by-token', { linkToken: token });
      setLink(current);
      if (current.delivery === 'email' && account?.email)
        setBlocked((await api<{ blocked: boolean }>('/links/optout')).blocked);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'LINK_LOGIN_REQUIRED') setLoginRequired(true);
      else throw cause;
    }
    setReady(true);
  }
  async function toggleBlocked() {
    await actions.run(async () => {
      const next = await api<{ blocked: boolean }>('/links/optout', {
        body: { blocked: !blocked },
      });
      setBlocked(next.blocked);
      if (next.blocked) {
        setLink(null);
        setDeclined(true);
      }
    });
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
  return (
    <>
      <div className="demo-banner">
        <span className="demo-mark">試用版</span>実際の支払いは発生しません
      </div>
      <header className="header shell request-link-header">
        <a className="wordmark" href="/">
          Favor
        </a>
      </header>
      <main className="shell request-link-landing">
        <div className="request-link-reader">
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
              <p className="account-copy">支払確保を解除しました。</p>
              {blocked && <p className="hint">今後、メールでの依頼は届きません。</p>}
              <a href="/">ホームへ</a>
            </div>
          )}
          {loginRequired && (
            <section className="request-detail link-registration" aria-label="受け取るアカウント">
              <h2>宛先のメールアドレスでログイン</h2>
              <p className="account-copy">
                この依頼はメールで届いたものです。届いたメールアドレスでログインすると開けます。
              </p>
              <SignInPanel options={options} onChange={load} />
            </section>
          )}
          {link && (
            <article className="request-detail" aria-label="依頼">
              <div className="detail-heading">
                <h1>{link.clientName}から</h1>
                <LinkStatus link={link} />
              </div>
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
                              setRecipientReady(false);
                              setAgreed(false);
                              setAuthenticate(true);
                            })
                          }
                        >
                          別のアカウントを使う
                        </button>
                      </div>
                      <RecipientAccount
                        key={identity.account.subject}
                        userId={identity.account.subject}
                        onReady={setRecipientReady}
                      />
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
                        disabled={actions.busy || !agreed || !recipientReady}
                        onClick={() => void accept()}
                      >
                        受ける
                        <Arrow />
                      </button>
                    </>
                  ) : authenticate ? (
                    <section className="link-registration" aria-label="受け取るアカウント">
                      <h3>受け取るアカウント</h3>
                      <SignInPanel options={options} onChange={load} />
                    </section>
                  ) : (
                    <button
                      className="primary"
                      disabled={actions.busy}
                      onClick={() => void accept()}
                    >
                      受ける
                      <Arrow />
                    </button>
                  )}
                  <div className="decline-link">
                    <ConfirmAction
                      label="見送る"
                      question="この依頼を見送りますか？"
                      busy={actions.busy}
                      onConfirm={decline}
                    />
                  </div>
                </div>
              )}
              {link.requestId && (
                <div className="detail-actions">
                  <Link className="primary" href={`/me/requests/${link.requestId}`}>
                    受けた依頼へ
                    <Arrow />
                  </Link>
                </div>
              )}
            </article>
          )}
          {link && link.delivery === 'email' && blocked !== null && (
            <p className="hint">
              <button
                className="text-button"
                disabled={actions.busy}
                onClick={() => void toggleBlocked()}
              >
                {blocked ? 'メールでの依頼を再び受け取る' : '今後、メールでの依頼を受け取らない'}
              </button>
            </p>
          )}
          {link && <p className="private-link-note">このリンクは第三者に共有しないでください</p>}
          {actions.error && !link && (
            <p className="hint">
              <Link href="/login">登録済みの方は、ログインして受けた依頼を確認できます。</Link>
            </p>
          )}
        </div>
      </main>
      <footer className="footer shell">
        <span className="footer-brand">Favor</span>
      </footer>
    </>
  );
}
