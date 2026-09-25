import type { Route } from './+types/api-identity';
import { api } from '../server/api';
import { whoami } from '../server/session';

export function loader(args: Route.LoaderArgs) {
  return api(() => whoami(args));
}
