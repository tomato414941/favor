import { isDomainFailure } from './session';

/** JSON answers for machine clients, with domain rules reported by status and code. */
export async function api(run: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return Response.json(await run(), { status });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isDomainFailure(error))
      return Response.json(
        { code: error.code, message: error.message },
        { status: error.statusCode },
      );
    throw error;
  }
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Response.json({ message: '入力内容または送信形式を確認してください。' }, { status: 400 });
  return body as Record<string, unknown>;
}
