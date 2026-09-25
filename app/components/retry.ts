import type { ClientActionFunctionArgs } from 'react-router';
import { NETWORK_MESSAGE } from './ui';

/** A lost connection becomes an inline message; the same change can then be sent again. */
export async function clientAction({ serverAction }: ClientActionFunctionArgs) {
  try {
    return await serverAction();
  } catch (error) {
    if (error instanceof TypeError) return { error: { code: 'NETWORK', message: NETWORK_MESSAGE } };
    throw error;
  }
}
