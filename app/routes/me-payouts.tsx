import type { Route } from './+types/me-payouts';
import { RecipientAccount } from '../components/RecipientAccount';
import { clientAction } from '../components/retry';
import { useAutoRevalidate } from '../components/ui';
import { favorOf } from '../server/context';
import { recipientAction } from '../server/recipient';
import { field, problem, requireIdentity } from '../server/session';
import { useMe } from './me';

export { clientAction };
export const meta: Route.MetaFunction = () => [{ title: '受取先 · Favor' }];

export async function loader(args: Route.LoaderArgs) {
  const who = await requireIdentity(args);
  try {
    return { account: await favorOf(args.context).service.recipients.status(who.account.subject) };
  } catch (error) {
    return problem(error);
  }
}
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const form = await args.request.formData();
  return recipientAction(
    favor,
    who.account.subject,
    field(form, 'intent'),
    favor.pageOrigin(args.request),
  );
}

export default function Payouts({ loaderData: { account } }: Route.ComponentProps) {
  const { identity } = useMe();
  useAutoRevalidate(30000, account.state !== 'ready');
  return (
    <RecipientAccount
      userId={identity.account.subject}
      account={account}
      action="/me/payouts"
      full
    />
  );
}
