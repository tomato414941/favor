import { useEffect, useState } from 'react';
import {
  data,
  Link,
  useFetcher,
  useLocation,
  useNavigation,
  useRevalidator,
  type ClientLoaderFunctionArgs,
} from 'react-router';
import type { Route } from './+types/link';
import type { IdentitySession, RecipientView, RequestLinkView } from '../../src/shared';
import { SignInPanel } from '../components/Auth';
import { LinkFacts, LinkStatus } from '../components/Links';
import { RecipientAccount } from '../components/RecipientAccount';
import { clientAction } from '../components/retry';
import {
  Arrow,
  ConfirmAction,
  DemoBanner,
  Footer,
  NETWORK_MESSAGE,
  useAutoRevalidate,
  useOperationKey,
  type ActionFailure,
} from '../components/ui';
import { useSite } from '../root';
import { favorOf } from '../server/context';
import { recipientAction } from '../server/recipient';
import { attempt, field, invalid, operationKey, whoami } from '../server/session';

export { clientAction };
export const meta: Route.MetaFunction = () => [{ title: '依頼 · Favor' }];

/** What the server knows without the token: who is signed in and their standing as a recipient. */
export async function loader(args: Route.LoaderArgs) {
  const favor = favorOf(args.context);
  const identity = await whoami(args);
  const [account, blocked] = identity
    ? await Promise.all([
        favor.service.recipients.status(identity.account.subject),
        identity.email ? favor.links.optout(identity.email).blocked : null,
      ])
    : [null, null];
  return { identity, account, blocked };
}

interface Landing {
  identity: IdentitySession | null;
  account: RecipientView | null;
  blocked: boolean | null;
  token: string;
  link: RequestLinkView | null;
  failure: { code: string; message: string } | null;
}
/** The token lives in the fragment, which only the browser sees; it travels in a header, never a URL. */
export async function clientLoader({ serverLoader }: ClientLoaderFunctionArgs): Promise<Landing> {
  // The router strips the fragment from its requests, so the token comes from the address bar.
  const token = window.location.hash.slice(1);
  const server = await serverLoader<typeof loader>();
  try {
    const response = await fetch('/api/links/by-token', {
      headers: { 'X-Favor-Link': token },
      credentials: 'same-origin',
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure =
        body && typeof body === 'object' && 'message' in body && 'code' in body
          ? (body as { code: string; message: string })
          : { code: '', message: '処理を完了できませんでした。もう一度お試しください。' };
      return { ...server, token, link: null, failure };
    }
    return { ...server, token, link: body as RequestLinkView, failure: null };
  } catch {
    return { ...server, token, link: null, failure: { code: 'NETWORK', message: NETWORK_MESSAGE } };
  }
}
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return (
    <Frame>
      <p className="loading" role="status">
        依頼を開いています…
      </p>
    </Frame>
  );
}

/** Accepting, declining, and mail preferences; the token arrives in the body. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await whoami(args);
  const form = await args.request.formData();
  const intent = field(form, 'intent');
  const token = field(form, 'token');
  const key = operationKey(form);
  if (intent === 'onboard' || intent === 'dashboard') {
    if (!who)
      throw data({ code: 'UNAUTHORIZED', message: 'ログインしてください。' }, { status: 401 });
    return recipientAction(favor, who.account.subject, intent, favor.pageOrigin(args.request));
  }
  return attempt(async () => {
    if (intent === 'decline') {
      await favor.links.decline(token, key, who?.account, who?.email);
      return { declined: true };
    }
    if (intent === 'accept') {
      if (!who)
        throw data({ code: 'UNAUTHORIZED', message: 'ログインしてください。' }, { status: 401 });
      const link = await favor.links.accept(
        who.account,
        token,
        key,
        form.get('agreeToRules') === 'on',
        who.email,
      );
      return { link };
    }
    if (intent === 'optout') {
      if (!who?.email)
        throw data(
          { code: 'EMAIL_REQUIRED', message: 'メールでログインしてください。' },
          { status: 403 },
        );
      const blocked = field(form, 'blocked') === '1';
      const result = await favor.links.setOptout(who.email, blocked);
      return { blocked: result.blocked, declined: result.blocked };
    }
    throw invalid();
  });
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DemoBanner />
      <header className="header shell request-link-header">
        <a className="wordmark" href="/">
          Favor
        </a>
      </header>
      <main className="shell request-link-landing">
        <div className="request-link-reader">{children}</div>
      </main>
      <Footer />
    </>
  );
}

type Outcome = ActionFailure & { link?: RequestLinkView; declined?: boolean; blocked?: boolean };

export default function LinkLanding({ loaderData }: Route.ComponentProps) {
  // Another token is another request: its answers start from nothing.
  return <Reader key={(loaderData as Landing).token} loaderData={loaderData as Landing} />;
}

function Reader({ loaderData }: { loaderData: Landing }) {
  const { identity, account, token, link, failure } = loaderData;
  const { mode } = useSite();
  const fetcher = useFetcher<Outcome>();
  const logout = useFetcher();
  const navigation = useNavigation();
  const location = useLocation();
  const revalidator = useRevalidator();
  const operation = useOperationKey();
  const [agreed, setAgreed] = useState(false);
  const [authenticate, setAuthenticate] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [blocked, setBlocked] = useState(loaderData.blocked);
  const busy = fetcher.state !== 'idle' || logout.state !== 'idle';
  const pending = link?.state === 'pending';
  useAutoRevalidate(30000, Boolean(identity && pending && account?.state !== 'ready'));
  useEffect(() => setBlocked(loaderData.blocked), [loaderData.blocked]);
  // Arriving from another page, the loader ran before the address bar changed: read the link again.
  const stale = location.hash.slice(1) !== token;
  useEffect(() => {
    if (stale && revalidator.state === 'idle') void revalidator.revalidate();
  }, [stale, revalidator.state]);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    if (fetcher.data.error) return;
    operation.done();
    if (fetcher.data.declined) setDeclined(true);
    if (typeof fetcher.data.blocked === 'boolean') setBlocked(fetcher.data.blocked);
  }, [fetcher.state, fetcher.data]);
  useEffect(() => {
    if (identity) setAuthenticate(false);
  }, [identity?.account.subject]);
  function submit(intent: 'accept' | 'decline', extra: Record<string, string> = {}) {
    void fetcher.submit(
      { intent, token, key: operation.keyFor({ intent, token }), ...extra },
      { method: 'post' },
    );
  }
  if (stale) return <HydrateFallback />;
  const error = fetcher.data?.error?.message ?? (declined ? null : failure?.message) ?? null;
  const loginRequired = failure?.code === 'LINK_LOGIN_REQUIRED' && !identity;
  const shown = declined ? null : link;
  return (
    <Frame>
      {error && !loginRequired && (
        <div className="message error" role="alert">
          {error}{' '}
          {failure && (
            <button
              disabled={busy || navigation.state !== 'idle'}
              onClick={() => window.location.reload()}
            >
              再確認
            </button>
          )}
        </div>
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
          <SignInPanel inline />
        </section>
      )}
      {shown && (
        <article className="request-detail" aria-label="依頼">
          <div className="detail-heading">
            <h1>{shown.clientName}から</h1>
            <LinkStatus link={shown} />
          </div>
          <LinkFacts link={shown} recipient />
          {shown.state === 'pending' && (
            <div className="detail-actions">
              {identity ? (
                <>
                  <div className="link-recipient-account">
                    <span>
                      <strong>{identity.email ?? identity.account.name}</strong>
                      として受け取ります。
                    </span>
                    {mode === 'demo' && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setAgreed(false);
                          setAuthenticate(true);
                          void logout.submit({ stay: '1' }, { method: 'post', action: '/logout' });
                        }}
                      >
                        別のアカウントを使う
                      </button>
                    )}
                  </div>
                  {account && (
                    <RecipientAccount
                      key={identity.account.subject}
                      userId={identity.account.subject}
                      account={account}
                      action="/link"
                    />
                  )}
                  <label className="checkbox-line request-link-agreement">
                    <input
                      type="checkbox"
                      checked={agreed}
                      disabled={busy}
                      onChange={(event) => setAgreed(event.target.checked)}
                    />
                    <span>内容・金額・期限を確認しました</span>
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !agreed || account?.state !== 'ready'}
                    onClick={() => submit('accept', { agreeToRules: 'on' })}
                  >
                    受ける
                    <Arrow />
                  </button>
                </>
              ) : authenticate ? (
                <section className="link-registration" aria-label="受け取るアカウント">
                  <h3>受け取るアカウント</h3>
                  <SignInPanel inline />
                </section>
              ) : (
                <button className="primary" disabled={busy} onClick={() => setAuthenticate(true)}>
                  受ける
                  <Arrow />
                </button>
              )}
              <div className="decline-link">
                <ConfirmAction
                  label="見送る"
                  question="この依頼を見送りますか？"
                  busy={busy}
                  onConfirm={() => submit('decline')}
                />
              </div>
            </div>
          )}
          {shown.requestId && (
            <div className="detail-actions">
              <Link className="primary" to={`/me/requests/${shown.requestId}`}>
                受けた依頼へ
                <Arrow />
              </Link>
            </div>
          )}
        </article>
      )}
      {shown && shown.delivery === 'email' && blocked !== null && (
        <p className="hint">
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void fetcher.submit(
                { intent: 'optout', token, blocked: blocked ? '0' : '1' },
                { method: 'post' },
              )
            }
          >
            {blocked ? 'メールでの依頼を再び受け取る' : '今後、メールでの依頼を受け取らない'}
          </button>
        </p>
      )}
      {shown && <p className="private-link-note">このリンクは第三者に共有しないでください</p>}
      {failure && !shown && !loginRequired && !declined && (
        <p className="hint">
          <Link to="/login">登録済みの方は、ログインして受けた依頼を確認できます。</Link>
        </p>
      )}
    </Frame>
  );
}
