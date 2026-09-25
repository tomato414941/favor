import { clerkMiddleware, rootAuthLoader } from '@clerk/react-router/server';
import { ClerkProvider } from '@clerk/react-router';
import { jaJP } from '@clerk/localizations';
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from 'react-router';
import type { Route } from './+types/root';
import type { IdentitySession } from '../src/shared';
import { favorOf } from './server/context';
import { whoami } from './server/session';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/600.css';
import '@fontsource/newsreader/500-italic.css';
import './styles/styles.css';
import './styles/home.css';
import './styles/request-form.css';

const BODY_LIMIT = 12 * 1024 * 1024;
const refuse = (message: string) => Response.json({ message }, { status: 403 });

export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, url, context }, next) => {
    const favor = favorOf(context);
    if (!favor.hostAllowed(request)) throw refuse('アクセス先のURLを確認してください。');
    const { pathname } = url;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      pathname !== '/api/payments/stripe-webhook'
    ) {
      if (Number(request.headers.get('content-length') ?? 0) > BODY_LIMIT)
        throw Response.json({ message: '送信できる大きさを超えています。' }, { status: 413 });
      // Machine clients prove intent with a header; browsers are checked by origin.
      if (pathname.startsWith('/api/') && request.headers.get('x-favor-action') !== '1')
        throw refuse('操作を確認できませんでした。');
      const origin = request.headers.get('origin');
      if (origin && !favor.actionOrigins(request).includes(origin))
        throw refuse('この送信元からは操作できません。');
      if (request.headers.get('sec-fetch-site') === 'cross-site')
        throw refuse('この送信元からは操作できません。');
    }
    const response = await next();
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
    return response;
  },
  async (args, next) => {
    const favor = favorOf(args.context);
    if (!favor.clerk) return next();
    return clerkMiddleware({
      publishableKey: favor.clerk.publishableKey,
      secretKey: favor.clerk.secretKey,
    })(args, next);
  },
];

export async function loader(args: Route.LoaderArgs) {
  const favor = favorOf(args.context);
  const identity = await whoami(args);
  const site = { mode: favor.mode, identity };
  return favor.mode === 'clerk' ? rootAuthLoader(args, () => site) : site;
}

export interface Site {
  mode: 'clerk' | 'demo';
  identity: IdentitySession | null;
}
/** The signed-in person and the sign-in mode, as the root loader saw them. */
export function useSite(): Site {
  const data = useRouteLoaderData<typeof loader>('root');
  return { mode: data?.mode ?? 'demo', identity: data?.identity ?? null };
}

export const meta: Route.MetaFunction = () => [{ title: 'Favor' }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#ffffff" />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='8' fill='%232a3035'/%3E%3Cpath d='M22 49V15h24M22 31h20' fill='none' stroke='white' stroke-width='7'/%3E%3C/svg%3E"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <div id="root">{children}</div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  if (loaderData.mode !== 'clerk') return <Outlet />;
  return (
    <ClerkProvider loaderData={loaderData} localization={jaJP}>
      <Outlet />
    </ClerkProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const missing = isRouteErrorResponse(error) && error.status === 404;
  const message =
    isRouteErrorResponse(error) &&
    error.data &&
    typeof error.data === 'object' &&
    'message' in error.data &&
    typeof error.data.message === 'string'
      ? error.data.message
      : '処理を完了できませんでした。時間をおいてお試しください。';
  return (
    <main className="shell works-page">
      <h1>{missing ? 'ページが見つかりません' : 'エラー'}</h1>
      {!missing && (
        <p className="message error" role="alert">
          {message}
        </p>
      )}
      <p>
        <Link to="/">ホームへ</Link>
      </p>
    </main>
  );
}
