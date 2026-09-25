import { useClerk } from '@clerk/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useFetcher, useLocation, useNavigate } from 'react-router';
import type { IdentitySession } from '../../src/shared';
import { useSite } from '../root';

export type Section = 'works' | 'new' | 'sent' | 'received' | 'mine' | 'settings' | null;

function ClerkLogout({ busy }: { busy: boolean }) {
  const clerk = useClerk();
  const navigate = useNavigate();
  return (
    <button
      className="menu-item"
      role="menuitem"
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
      <button className="menu-item" role="menuitem" disabled={busy || fetcher.state !== 'idle'}>
        ログアウト
      </button>
    </fetcher.Form>
  );
}

/** The signed-in person's own settings, behind their name; closes on Escape, outside clicks, and navigation. */
function AccountMenu({ label, active, busy }: { label: string; active: Section; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div
      className="account-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          root.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="account-name">{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className="account-popover" role="menu" id={menuId} aria-label="アカウント">
          <Link
            className="menu-item"
            role="menuitem"
            to="/me/settings"
            aria-current={active === 'settings' ? 'page' : undefined}
          >
            設定
          </Link>
          <LogoutButton busy={busy} />
        </div>
      )}
    </div>
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
  const label = identity?.email ?? identity?.account.name ?? '';
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
          <AccountMenu label={label} active={active} busy={busy} />
        </>
      ) : (
        <div className="account-menu">
          <Link to="/login">ログイン</Link>
        </div>
      )}
    </header>
  );
}
