import type { Route } from './+types/api-requests';
import { api } from '../server/api';
import { favorOf } from '../server/context';
import { requireIdentity } from '../server/session';

export function loader(args: Route.LoaderArgs) {
  return api(async () => ({
    requests: favorOf(args.context).service.list((await requireIdentity(args)).account.subject),
  }));
}
