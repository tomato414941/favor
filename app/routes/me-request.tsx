import { Link } from 'react-router';
import type { Route } from './+types/me-request';
import type { UploadInput } from '../../src/shared';
import { RequestDetail } from '../components/RequestDetail';
import { clientAction } from '../components/retry';
import { favorOf } from '../server/context';
import { attempt, field, invalid, operationKey, requireIdentity } from '../server/session';
import { useMe } from './me';

export { clientAction };

/** Stops a request, or delivers files for it. */
export async function action(args: Route.ActionArgs) {
  const favor = favorOf(args.context);
  const who = await requireIdentity(args);
  const form = await args.request.formData();
  const intent = field(form, 'intent');
  const key = operationKey(form);
  const actor = who.account.subject;
  return attempt(async () => {
    if (intent === 'cancel')
      return {
        request: await favor.service.cancel(actor, args.params.id, key),
        notice: '依頼を中止しました。',
      };
    if (intent !== 'deliver') throw invalid();
    const files: UploadInput[] = [];
    for (const entry of form.getAll('files')) {
      if (!(entry instanceof File)) throw invalid();
      files.push({
        name: entry.name,
        content: Buffer.from(await entry.arrayBuffer()).toString('base64'),
      });
    }
    const request = await favor.service.deliver(actor, args.params.id, key, files);
    return {
      request,
      notice: request.state === 'delivered' ? '作品を渡しました。' : '支払いを確認しています。',
    };
  });
}

export default function RequestPage({ params }: Route.ComponentProps) {
  const { requests, settings } = useMe();
  const current = requests.find((request) => request.id === params.id);
  const received = current?.viewerRole === 'creator';
  return (
    <div className="detail-page">
      <Link className="back-link" to={received ? '/me/received' : '/me/sent'}>
        {received ? '受けた依頼へ' : '送った依頼へ'}
      </Link>
      {current ? (
        <RequestDetail
          key={current.id}
          request={current}
          role={current.viewerRole}
          limits={settings.limits}
        />
      ) : (
        <p className="empty-state">依頼が見つかりません</p>
      )}
    </div>
  );
}
