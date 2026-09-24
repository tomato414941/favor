export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ApiOptions {
  body?: unknown;
  key?: string;
  linkToken?: string;
}

export async function api<T>(path: string, { body, key, linkToken }: ApiOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: {
        ...(linkToken ? { 'X-Favor-Link': linkToken } : {}),
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-Favor-Action': '1',
              ...(key ? { 'Idempotency-Key': key } : {}),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('接続を確認できませんでした。内容はそのままで、もう一度お試しください。');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : '処理を完了できませんでした。もう一度お試しください。';
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function encodeFile(file: File): Promise<{ name: string; content: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error('ファイルを読み取れませんでした。もう一度選んでください。'));
    reader.onload = () =>
      resolve({ name: file.name, content: String(reader.result).split(',')[1] ?? '' });
    reader.readAsDataURL(file);
  });
}
