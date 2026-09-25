import { data } from 'react-router';
import type { Route } from './+types/me-new';
import { RequestForm } from '../components/RequestForm';
import { clientAction } from '../components/retry';
import { favorOf } from '../server/context';
import { createLink, parseLinkInput } from '../server/links';
import { attempt, operationKey, requireIdentity } from '../server/session';
import { useMe } from './me';

export { clientAction };

export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const form = await args.request.formData();
  const input = parseLinkInput(form);
  if (!input)
    return data(
      { error: { code: 'INVALID_INPUT', message: '入力内容または送信形式を確認してください。' } },
      { status: 400 },
    );
  return attempt(() =>
    createLink(
      favor,
      who.account.subject,
      operationKey(form),
      input,
      favor.pageOrigin(args.request),
    ),
  );
}

export default function New() {
  const { settings } = useMe();
  return (
    <div className="compose-layout">
      <RequestForm settings={settings} />
    </div>
  );
}
