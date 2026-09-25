import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { favorOf } from '../server/context';
import { demoToken, field, sessionCookie } from '../server/session';

/** Ends the demo session. Clerk sessions end in the browser; this only clears the cookie. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  favor.auth.logout(await demoToken(favor, args.request));
  const form = await args.request.formData().catch(() => new FormData());
  const headers = { 'Set-Cookie': await sessionCookie(favor).serialize('', { maxAge: 0 }) };
  if (field(form, 'stay') === '1') return Response.json({ ok: true }, { headers });
  return redirect('/', { headers });
}
export function loader() {
  throw redirect('/');
}
