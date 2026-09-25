import { data } from 'react-router';
import type { Favor } from '../../src/server/favor';
import { attempt } from './session';

/** The sign-up and dashboard steps at Stripe, shared by the payouts page and link landing. */
export function recipientAction(favor: Favor, actor: string, intent: string, origin: string) {
  return attempt(async () => {
    if (intent === 'onboard')
      return data({ url: (await favor.service.recipients.onboard(actor, origin)).url });
    if (intent === 'dashboard')
      return data({ url: (await favor.service.recipients.dashboard(actor)).url });
    return data(
      { error: { code: 'INVALID_INPUT', message: '操作を確認できませんでした。' } },
      { status: 400 },
    );
  });
}
