import { useEffect, useState } from 'react';
import { data, Link, useFetcher } from 'react-router';
import type { Route } from './+types/me-settings';
import { PLATFORM_FEE_PERCENT } from '../../src/shared';
import { RecipientAccount } from '../components/RecipientAccount';
import { clientAction } from '../components/retry';
import { useAutoRevalidate, type ActionFailure } from '../components/ui';
import { favorOf } from '../server/context';
import { recipientAction } from '../server/recipient';
import { attempt, field, invalid, problem, requireIdentity } from '../server/session';
import { useSite } from '../root';
import { useMe } from './me';

export { clientAction };
export const meta: Route.MetaFunction = () => [{ title: '設定 · Favor' }];

export async function loader(args: Route.LoaderArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const actor = who.account.subject;
  try {
    return {
      profile: favor.service.profile(actor),
      maximumNameLength: favor.service.policy.maximumNameLength,
      mail: who.email ? { blocked: favor.links.optout(who.email).blocked } : null,
      account: await favor.service.recipients.status(actor),
    };
  } catch (error) {
    return problem(error);
  }
}

/** Saves the display name, the mail preference, or opens Stripe. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const form = await args.request.formData();
  const intent = field(form, 'intent');
  const actor = who.account.subject;
  if (intent === 'onboard' || intent === 'dashboard')
    return recipientAction(favor, actor, intent, favor.pageOrigin(args.request));
  return attempt(async () => {
    if (intent === 'profile')
      return { profile: favor.service.setDisplayName(actor, field(form, 'displayName')) };
    if (intent === 'mail') {
      if (!who.email)
        throw data(
          { error: { code: 'EMAIL_REQUIRED', message: 'メールでログインしてください。' } },
          { status: 403 },
        );
      return { mail: await favor.links.setOptout(who.email, field(form, 'blocked') === '1') };
    }
    throw invalid();
  });
}

function Profile({ name, maximum }: { name: string; maximum: number }) {
  const fetcher = useFetcher<ActionFailure & { profile?: { displayName: string | null } }>();
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const busy = fetcher.state !== 'idle';
  const saved = !busy && fetcher.data?.profile !== undefined && !fetcher.data.error;
  return (
    <section className="settings-section" aria-labelledby="settings-profile">
      <h2 id="settings-profile">プロフィール</h2>
      <fetcher.Form method="post" className="settings-form">
        <input type="hidden" name="intent" value="profile" />
        <div className="field">
          <label htmlFor="display-name">表示名</label>
          <input
            id="display-name"
            className="text-input"
            name="displayName"
            value={value}
            maxLength={maximum}
            autoComplete="nickname"
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="hint">依頼の相手と、公開作品のページに表示されます。</p>
        </div>
        {fetcher.data?.error && (
          <p className="inline-error" role="alert">
            {fetcher.data.error.message}
          </p>
        )}
        <div className="action-buttons">
          <button className="quiet-button" type="submit" disabled={busy || value === name}>
            保存
          </button>
          {saved && value === name && <span role="status">保存しました</span>}
        </div>
      </fetcher.Form>
    </section>
  );
}

function MailPreference({ blocked }: { blocked: boolean }) {
  const fetcher = useFetcher<ActionFailure>();
  const busy = fetcher.state !== 'idle';
  return (
    <section className="settings-section" aria-labelledby="settings-mail">
      <h2 id="settings-mail">依頼の受け取り</h2>
      <p>
        {blocked
          ? 'メールで届く依頼を受け取らない設定です。'
          : 'メールアドレス宛に送られた依頼を受け取ります。'}
      </p>
      {fetcher.data?.error && (
        <p className="inline-error" role="alert">
          {fetcher.data.error.message}
        </p>
      )}
      <div className="action-buttons">
        <button
          className="quiet-button"
          disabled={busy}
          onClick={() =>
            void fetcher.submit(
              { intent: 'mail', blocked: blocked ? '0' : '1' },
              { method: 'post' },
            )
          }
        >
          {blocked ? 'メールでの依頼を再び受け取る' : 'メールでの依頼を受け取らない'}
        </button>
      </div>
      {!blocked && (
        <p className="hint">受け取らない設定にすると、受諾待ちの依頼も取り消されます。</p>
      )}
    </section>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { identity } = useMe();
  const { mode } = useSite();
  const { profile, maximumNameLength, mail, account } = loaderData;
  useAutoRevalidate(30000, account.state !== 'ready');
  return (
    <div className="settings-page">
      <h1 className="page-title">設定</h1>
      <Profile name={profile.displayName ?? profile.name} maximum={maximumNameLength} />
      {mode === 'clerk' && (
        <section className="settings-section" aria-labelledby="settings-account">
          <h2 id="settings-account">アカウント</h2>
          <p>メールアドレスの変更、Google や X との連携、ログイン中の端末の確認。</p>
          <div className="action-buttons">
            <Link className="quiet-button" to="/me/account">
              アカウントを管理
            </Link>
          </div>
        </section>
      )}
      {mail && <MailPreference blocked={mail.blocked} />}
      <section className="settings-section" aria-labelledby="settings-payouts">
        <h2 id="settings-payouts">売上の受け取り</h2>
        <p>
          受取額は金額から利用料{PLATFORM_FEE_PERCENT}%（税込）を引いた額です。Stripe
          から毎週金曜日にお振込みします。振込手数料はかかりません。
        </p>
        <RecipientAccount
          userId={identity.account.subject}
          account={account}
          action="/me/settings"
          full
        />
      </section>
    </div>
  );
}
