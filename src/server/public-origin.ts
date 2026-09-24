export function parsePublicOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('FAVOR_PUBLIC_ORIGIN must be a valid origin.');
  }
  if (
    origin.origin !== value ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
    )
  ) {
    throw new Error(
      'FAVOR_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback).',
    );
  }
  return origin;
}
