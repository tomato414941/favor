import { useClerk } from '@clerk/react-router';
import { Link, useFetcher, useNavigate } from 'react-router';
import type { IdentitySession } from '../../src/shared';
import { useSite } from '../root';

export type Section = 'works' | 'new' | 'sent' | 'received' | 'mine' | 'payouts' | null;

function ClerkLogout({ busy }: { busy: boolean }) {
  const clerk = useClerk();
  const navigate = useNavigate();
  return (
    <button
      className="text-button"
      disabled={busy}
      onClick={() => void clerk.signOut().then(() => navigate('/', { replace: true }))}
    >
      ログアウト
    </button>
  );
}
export function LogoutButton({ busy = false }: { busy?: boolean }) {
  const { mode } = useSite();
  const fetcher = useFetcher();
  if (mode === 'clerk') return <ClerkLogout busy={busy} />;
  return (
    <fetcher.Form method="post" action="/logout">
      <button className="text-button" disabled={busy || fetcher.state !== 'idle'}>
        ログアウト
      </button>
    </fetcher.Form>
  );
}

/** One header for every page: the site on the left, the signed-in person's own pages on the right. */
export function SiteHeader({
  identity,
  active,
  counts,
  busy = false,
}: {
  identity: IdentitySession | null;
  active: Section;
  counts?: { sent: number; received: number };
  busy?: boolean;
}) {
  const me = identity?.registered ?? false;
  const label = identity?.email ?? identity?.account.name;
  return (
    <header className="header shell">
      <Link className="wordmark" to="/" aria-label="Favor ホーム">
        Favor
      </Link>
      <Link
        className="site-link"
        to="/works"
        aria-current={active === 'works' ? 'page' : undefined}
      >
        公開作品
      </Link>
      {me ? (
        <>
          <nav aria-label="自分のページ">
            <Link to="/me/new" aria-current={active === 'new' ? 'page' : undefined}>
              お願いを書く
            </Link>
            <Link to="/me/sent" aria-current={active === 'sent' ? 'page' : undefined}>
              送った依頼
              {counts && <span className="count">{counts.sent}</span>}
            </Link>
            <Link to="/me/received" aria-current={active === 'received' ? 'page' : undefined}>
              受けた依頼
              {counts && <span className="count">{counts.received}</span>}
            </Link>
            <Link to="/me/works" aria-current={active === 'mine' ? 'page' : undefined}>
              自分の作品
            </Link>
          </nav>
          <div className="account-menu">
            <Link to="/me/payouts" aria-current={active === 'payouts' ? 'page' : undefined}>
              受取先
            </Link>
            <span title={label}>{label}</span>
            <LogoutButton busy={busy} />
          </div>
        </>
      ) : (
        <div className="account-menu">
          <Link to="/login">ログイン</Link>
        </div>
      )}
    </header>
  );
}
