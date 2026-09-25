import { createContext, type RouterContextProvider } from 'react-router';
import type { Favor } from '../../src/server/favor';

/** The running application, attached to every request by the server entrypoint. */
export const favorContext = createContext<Favor | null>(null);

export type RequestContext = Readonly<RouterContextProvider>;
export function favorOf(context: RequestContext): Favor {
  const favor = context.get(favorContext);
  if (!favor) throw new Error('Favor is not attached to this request.');
  return favor;
}
