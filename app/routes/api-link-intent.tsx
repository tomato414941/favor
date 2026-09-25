import type { Route } from './+types/api-link-intent';
import { api } from '../server/api';
import { favorOf } from '../server/context';
import { linkIntent } from '../server/links';
import { requireIdentity } from '../server/session';

const intents: Record<string, string> = {
  checkout: 'checkout',
  'complete-payment': 'complete',
  reissue: 'reissue',
  withdraw: 'withdraw',
};
export function action(args: Route.ActionArgs) {
  return api(async () => {
    const intent = intents[args.params.intent];
    if (args.request.method !== 'POST' || !intent) throw Response.json(null, { status: 404 });
    const favor = favorOf(args.context);
    const who = await requireIdentity(args);
    return linkIntent(
      favor,
      who.account.subject,
      args.params.id,
      intent,
      args.request.headers.get('idempotency-key') ?? '',
      favor.pageOrigin(args.request),
    );
  });
}
