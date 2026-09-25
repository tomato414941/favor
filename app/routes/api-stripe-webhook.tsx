import type { Route } from './+types/api-stripe-webhook';
import { api } from '../server/api';
import { favorOf } from '../server/context';

const LIMIT = 256 * 1024;
/** Stripe's signed notifications; the body is verified as received. */
export function action({ request, context }: Route.ActionArgs) {
  return api(async () => {
    const favor = favorOf(context);
    if (request.method !== 'POST' || !favor.service.payments.provider.event)
      throw Response.json(null, { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > LIMIT)
      throw Response.json(null, { status: 413 });
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > LIMIT) throw Response.json(null, { status: 413 });
    await favor.service.payments.webhook(body, request.headers.get('stripe-signature') ?? '');
    return { received: true };
  });
}
export function loader() {
  return Response.json(null, { status: 404 });
}
