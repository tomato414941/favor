import { createClerkClient, verifyToken } from '@clerk/backend';

/** Who is making a request, as established by the identity provider. */
export interface ResolvedIdentity {
  subject: string;
  email: string | null;
  name: string;
}
export interface IdentityRequest {
  cookies: Partial<Record<string, string>>;
  headers: Partial<Record<string, string | string[]>>;
}
export type IdentityResolver = (request: IdentityRequest) => Promise<ResolvedIdentity | null>;

const PROFILE_TTL_MS = 300_000;

export function bearer(request: IdentityRequest): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer\s+(\S+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

/** Verifies Clerk session tokens from the __session cookie or a bearer header and looks up the profile. */
export function clerkResolver(config: {
  secretKey: string;
  publishableKey: string;
  authorizedParties?: string[];
}): IdentityResolver {
  if (!config.secretKey.startsWith('sk_') || !config.publishableKey.startsWith('pk_'))
    throw new Error('CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required.');
  const client = createClerkClient({
    secretKey: config.secretKey,
    publishableKey: config.publishableKey,
  });
  const profiles = new Map<string, { at: number; identity: ResolvedIdentity }>();
  return async (request) => {
    const token = request.cookies.__session ?? bearer(request);
    if (!token) return null;
    let subject: string;
    try {
      const claims = await verifyToken(token, {
        secretKey: config.secretKey,
        ...(config.authorizedParties ? { authorizedParties: config.authorizedParties } : {}),
      });
      if (typeof claims.sub !== 'string') return null;
      subject = claims.sub;
    } catch {
      return null;
    }
    const cached = profiles.get(subject);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.identity;
    const user = await client.users.getUser(subject);
    const primary = user.emailAddresses.find((item) => item.id === user.primaryEmailAddressId);
    const email = (primary ?? user.emailAddresses[0])?.emailAddress.trim().toLowerCase() ?? null;
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
      user.username ||
      (email ? email.split('@')[0]! : `ユーザー ${subject.slice(-8)}`);
    const identity = { subject, email, name };
    profiles.set(subject, { at: Date.now(), identity });
    return identity;
  };
}
