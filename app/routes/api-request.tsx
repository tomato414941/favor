import type { Route } from './+types/api-request';
import { api } from '../server/api';
import { favorOf } from '../server/context';
import { requireIdentity } from '../server/session';

export function loader(args: Route.LoaderArgs) {
  return api(async () =>
    favorOf(args.context).service.get(
      (await requireIdentity(args)).account.subject,
      args.params.id,
    ),
  );
}
