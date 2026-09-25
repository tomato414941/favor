import type { RequestLinkInput, RequestLinkResult } from '../../src/shared';
import type { Favor } from '../../src/server/favor';

/** Creates a link and, for mailed requests, sends it; the token is returned only for shared links. */
export async function createLink(
  favor: Favor,
  actor: string,
  key: string,
  input: RequestLinkInput,
  origin: string,
): Promise<RequestLinkResult> {
  const created = await favor.links.create(actor, key, input, origin);
  if (created.link.state === 'awaiting_payment' || created.link.delivery !== 'email')
    return created;
  if (created.token) await favor.links.send(actor, created.link.id, created.token, origin, true);
  return { link: favor.links.get(actor, created.link.id) };
}
export async function linkIntent(
  favor: Favor,
  actor: string,
  id: string,
  intent: string,
  key: string,
  origin: string,
): Promise<RequestLinkResult | null> {
  if (intent === 'checkout') return favor.links.checkout(actor, id);
  if (intent === 'withdraw') return { link: await favor.links.withdraw(actor, id, key) };
  if (intent !== 'complete' && intent !== 'reissue') return null;
  const result =
    intent === 'complete'
      ? await favor.links.complete(actor, id, key)
      : favor.links.reissue(actor, id, key);
  if (result.link.delivery !== 'email') return result;
  if (result.token)
    await favor.links.send(actor, result.link.id, result.token, origin, intent === 'complete');
  return { link: favor.links.get(actor, result.link.id) };
}
export function parseLinkInput(form: FormData): RequestLinkInput | null {
  const brief = form.get('brief');
  const amount = form.get('amount');
  const visibility = form.get('visibility');
  const delivery = form.get('delivery') ?? 'self';
  const recipientEmail = form.get('recipientEmail');
  if (
    typeof brief !== 'string' ||
    typeof amount !== 'string' ||
    !/^\d{1,9}$/.test(amount) ||
    typeof visibility !== 'string' ||
    !['public', 'anonymous', 'hidden'].includes(visibility) ||
    (delivery !== 'self' && delivery !== 'email') ||
    (recipientEmail !== null && typeof recipientEmail !== 'string')
  )
    return null;
  return {
    brief,
    amount: Number(amount),
    visibility: visibility as RequestLinkInput['visibility'],
    agreeToRules: form.get('agreeToRules') === 'on',
    delivery,
    ...(recipientEmail === null ? {} : { recipientEmail }),
  };
}
