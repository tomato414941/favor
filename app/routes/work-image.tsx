import type { Route } from './+types/work-image';
import { favorOf } from '../server/context';
import { api } from '../server/api';

/** Images of a public work, shown inline. Other files stay between the two parties. */
export function loader({ context, params }: Route.LoaderArgs) {
  return api(async () => {
    const file = favorOf(context).service.publicImage(params.id, params.fileId);
    throw new Response(Buffer.from(file.data), {
      headers: {
        'Content-Type': file.type,
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, max-age=300',
      },
    });
  });
}
