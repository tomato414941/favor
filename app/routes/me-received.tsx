import type { Route } from './+types/me-received';
import { RequestList } from '../components/RequestList';
import { useMe } from './me';

export const meta: Route.MetaFunction = () => [{ title: '受けた依頼 · Favor' }];

export default function Received() {
  const { requests } = useMe();
  return (
    <RequestList
      side="received"
      requests={requests.filter((request) => request.viewerRole === 'creator')}
      links={[]}
    />
  );
}
