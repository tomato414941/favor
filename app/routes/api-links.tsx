import type { Route } from './+types/api-links';
import type { RequestLinkInput } from '../../src/shared';
import { api, jsonBody } from '../server/api';
import { favorOf } from '../server/context';
import { createLink } from '../server/links';
import { requireIdentity } from '../server/session';

export function loader(args: Route.LoaderArgs) {
  return api(async () => ({
    links: favorOf(args.context).links.list((await requireIdentity(args)).account.subject),
  }));
}
/** Creates a request link for a machine client; the same rules as the page apply. */
export function action(args: Route.ActionArgs) {
  return api(async () => {
    if (args.request.method !== 'POST') throw Response.json(null, { status: 405 });
    const favor = favorOf(args.context);
    const who = await requireIdentity(args);
    const body = await jsonBody(args.request);
    const allowed = ['brief', 'amount', 'visibility', 'agreeToRules', 'delivery', 'recipientEmail'];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw Response.json(
        { message: '入力内容または送信形式を確認してください。' },
        { status: 400 },
      );
    const key = args.request.headers.get('idempotency-key') ?? '';
    return createLink(
      favor,
      who.account.subject,
      key,
      body as unknown as RequestLinkInput,
      favor.pageOrigin(args.request),
    );
  }, 201);
}
