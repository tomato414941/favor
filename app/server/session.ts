import { getAuth } from '@clerk/react-router/server';
import { createCookie, data, type LoaderFunctionArgs } from 'react-router';
import type { IdentitySession } from '../../src/shared';
import type { Favor } from '../../src/server/favor';
import { favorOf, type RequestContext } from './context';

export interface RequestArgs {
  request: Request;
  context: RequestContext;
  params: Record<string, string | undefined>;
}
export interface DomainFailure {
  code: string;
  message: string;
  statusCode: number;
}
export const isDomainFailure = (error: unknown): error is DomainFailure =>
  error instanceof Error &&
  typeof (error as Partial<DomainFailure>).code === 'string' &&
  typeof (error as Partial<DomainFailure>).statusCode === 'number';

/** A domain rule was broken: answer with its code and message and the status it carries. */
export function problem(error: unknown): never {
  if (isDomainFailure(error))
    throw data({ code: error.code, message: error.message }, { status: error.statusCode });
  throw error;
}
export const invalid = (message = '入力内容または送信形式を確認してください。') =>
  data({ code: 'INVALID_INPUT', message }, { status: 400 });

export function sessionCookie(favor: Favor) {
  return createCookie(favor.sessionCookieName, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 86400,
    secure: favor.secureCookies,
  });
}
export async function demoToken(favor: Favor, request: Request): Promise<string | undefined> {
  const value: unknown = await sessionCookie(favor).parse(request.headers.get('cookie'));
  return typeof value === 'string' ? value : undefined;
}

/** Who is signed in, or null. Clerk answers for its sessions; demo tokens live in memory. */
export async function whoami(args: RequestArgs): Promise<IdentitySession | null> {
  const favor = favorOf(args.context);
  if (favor.mode === 'clerk') {
    const auth = await getAuth(args as unknown as LoaderFunctionArgs);
    return auth.userId ? favor.admitClerk(auth.userId) : null;
  }
  try {
    return favor.auth.identity(await demoToken(favor, args.request));
  } catch (error) {
    if (isDomainFailure(error) && error.statusCode === 401) return null;
    throw error;
  }
}
export async function requireIdentity(args: RequestArgs): Promise<IdentitySession> {
  const who = await whoami(args);
  if (!who)
    throw data({ code: 'UNAUTHORIZED', message: 'ログインしてください。' }, { status: 401 });
  return who;
}

/** Runs a change and reports a broken rule as data instead of an error page. */
export async function attempt<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (isDomainFailure(error))
      return data(
        { error: { code: error.code, message: error.message } },
        { status: error.statusCode },
      );
    throw error;
  }
}
export const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
export const operationKey = (form: FormData) => field(form, 'key');
/** Only pages a signed-in person owns are safe to return to after signing in. */
export const ownPath = (value: string | null) =>
  value && /^\/me(\/[A-Za-z0-9/_-]*)?$/.test(value) ? value : null;
