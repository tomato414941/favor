import { Outlet, redirect, useLocation, useRouteLoaderData } from 'react-router';
import type { Route } from './+types/me';
import type { IdentitySession, RequestLinkView, RequestView, SessionView } from '../../src/shared';
import { SiteHeader, type Section } from '../components/Header';
import type { RequestFormSettings } from '../components/RequestForm';
import { DemoBanner, Footer, useAutoRevalidate } from '../components/ui';
import { favorOf } from '../server/context';
import { whoami } from '../server/session';

export interface Me {
  identity: IdentitySession;
  session: SessionView;
  requests: RequestView[];
  links: RequestLinkView[];
  settings: RequestFormSettings;
}

/** Everything the signed-in person's pages show; anyone else is sent to sign in first. */
export async function loader(args: Route.LoaderArgs): Promise<Me> {
  const favor = favorOf(args.context);
  const identity = await whoami(args);
  if (!identity) throw redirect(`/login?next=${encodeURIComponent(args.url.pathname)}`);
  const actor = identity.account.subject;
  const { service, links } = favor;
  const policy = service.policy;
  return {
    identity,
    session: service.session(actor),
    requests: service.list(actor),
    links: links.list(actor),
    settings: {
      paymentMode: service.payments.provider.mode,
      terms: {
        recommendedAmount: policy.recommendedAmount,
        minimumAmount: policy.minimumAmount,
        acceptanceDays:
          Math.min(policy.acceptanceMs, policy.authorizationMs, policy.deliveryMs) / 86_400_000,
        deliveryDays: policy.deliveryMs / 86_400_000,
      },
      limits: {
        brief: policy.maximumBriefLength,
        files: policy.maximumFiles,
        uploadBytes: policy.maximumUploadBytes,
        maximumAmount: policy.maximumAmount,
      },
    },
  };
}

export function useMe(): Me {
  const me = useRouteLoaderData<typeof loader>('routes/me');
  if (!me) throw new Error('The signed-in person is not loaded.');
  return me;
}
export const pendingOf = (links: RequestLinkView[]) =>
  links.filter((link) => link.state !== 'accepted');

export default function MeLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const { identity, requests, links } = loaderData;
  useAutoRevalidate(5000);
  const sent = requests.filter((request) => request.viewerRole === 'client');
  const received = requests.filter((request) => request.viewerRole === 'creator');
  const request = /^\/me\/requests\/([^/]+)$/.exec(pathname);
  const current = request ? requests.find((item) => item.id === request[1]) : undefined;
  const active: Section = pathname.startsWith('/me/new')
    ? 'new'
    : pathname.startsWith('/me/works')
      ? 'mine'
      : pathname.startsWith('/me/settings')
        ? 'settings'
        : pathname.startsWith('/me/received') || current?.viewerRole === 'creator'
          ? 'received'
          : 'sent';
  return (
    <div className="workspace">
      <DemoBanner />
      <SiteHeader
        identity={identity}
        active={active}
        counts={{ sent: pendingOf(links).length + sent.length, received: received.length }}
      />
      <main className="shell">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
