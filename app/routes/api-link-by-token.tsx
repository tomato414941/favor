import type { Route } from './+types/api-link-by-token';
import { api } from '../server/api';
import { favorOf } from '../server/context';
import { whoami } from '../server/session';

/** Reads a request by its private token, which travels in a header and never in the URL. */
export function loader(args: Route.LoaderArgs) {
  return api(async () => {
    const who = await whoami(args);
    const token = args.request.headers.get('x-favor-link') ?? '';
    return favorOf(args.context).links.read(token, who?.account, who?.email);
  });
}
