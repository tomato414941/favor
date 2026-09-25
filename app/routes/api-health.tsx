import type { Route } from './+types/api-health';
import { favorOf } from '../server/context';

export function loader({ context }: Route.LoaderArgs) {
  return Response.json({ ok: true, demoAuth: favorOf(context).mode === 'demo' });
}
