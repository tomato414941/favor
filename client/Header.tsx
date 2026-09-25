import type { IdentitySession } from '../src/shared';
import { Link } from './ui';

export type Section = 'works' | 'new' | 'sent' | 'received' | 'mine' | 'payouts' | null;

/** One header for every page: the site on the left, the signed-in person's own pages on the right. */
export function SiteHeader({
  identity,
  active,
  counts,
  label,
  onLogout,
  busy = false,
}: {
  identity: IdentitySession | null;
  active: Section;
  counts?: { sent: number; received: number };
  label?: string;
  onLogout?: () => void;
  busy?: boolean;
}) {
  const me = identity?.registered ?? false;
  return (
    <header className="header shell">
      <Link className="wordmark" href="/" aria-label="Favor ホーム">
        Favor
      </Link>
      <Link
        className="site-link"
        href="/works"
        aria-current={active === 'works' ? 'page' : undefined}
      >
        公開作品
      </Link>
      {me ? (
        <>
          <nav aria-label="自分のページ">
            <Link href="/me/new" aria-current={active === 'new' ? 'page' : undefined}>
              お願いを書く
            </Link>
            <Link href="/me/sent" aria-current={active === 'sent' ? 'page' : undefined}>
              送った依頼
              {counts && <span className="count">{counts.sent}</span>}
            </Link>
            <Link href="/me/received" aria-current={active === 'received' ? 'page' : undefined}>
              受けた依頼
              {counts && <span className="count">{counts.received}</span>}
            </Link>
            <Link href="/me/works" aria-current={active === 'mine' ? 'page' : undefined}>
              自分の作品
            </Link>
          </nav>
          <div className="account-menu">
            <Link href="/me/payouts" aria-current={active === 'payouts' ? 'page' : undefined}>
              受取先
            </Link>
            <span title={label ?? identity?.email ?? identity?.account.name}>
              {label ?? identity?.email ?? identity?.account.name}
            </span>
            {onLogout && (
              <button className="text-button" disabled={busy} onClick={onLogout}>
                ログアウト
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="account-menu">
          <Link href="/login">ログイン</Link>
        </div>
      )}
    </header>
  );
}
