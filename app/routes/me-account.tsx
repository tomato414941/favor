import { UserProfile } from '@clerk/react-router';
import { Link, redirect } from 'react-router';
import type { Route } from './+types/me-account';
import { favorOf } from '../server/context';
import { requireIdentity } from '../server/session';

export const meta: Route.MetaFunction = () => [{ title: 'アカウント · Favor' }];

/** Clerk's own account management: addresses, connected sign-ins, and sessions. */
export async function loader(args: Route.LoaderArgs) {
  await requireIdentity(args);
  if (favorOf(args.context).mode !== 'clerk') throw redirect('/me/settings');
  return null;
}

export default function Account() {
  return (
    <div className="detail-page account-page">
      <Link className="back-link" to="/me/settings">
        設定へ
      </Link>
      <UserProfile routing="hash" />
    </div>
  );
}
