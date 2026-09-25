import type { Route } from './+types/me-request-file';
import { favorOf } from '../server/context';
import { api } from '../server/api';
import { requireIdentity } from '../server/session';

/** A delivered file, for the two parties once the payment is captured. */
export function loader(args: Route.LoaderArgs) {
  return api(async () => {
    const who = await requireIdentity(args);
    const file = favorOf(args.context).service.download(
      who.account.subject,
      args.params.id,
      args.params.fileId,
    );
    const encodedName = encodeURIComponent(file.name).replace(
      /['()*]/g,
      (s) => `%${s.charCodeAt(0).toString(16)}`,
    );
    throw new Response(Buffer.from(file.data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
        'Content-Security-Policy': "sandbox; default-src 'none'",
      },
    });
  });
}
