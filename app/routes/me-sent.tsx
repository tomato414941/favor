import type { Route } from './+types/me-sent';
import { RequestList } from '../components/RequestList';
import { pendingOf, useMe } from './me';

export const meta: Route.MetaFunction = () => [{ title: '送った依頼 · Favor' }];

export default function Sent() {
  const { requests, links } = useMe();
  return (
    <RequestList
      side="sent"
      requests={requests.filter((request) => request.viewerRole === 'client')}
      links={pendingOf(links)}
    />
  );
}
