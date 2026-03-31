export function json(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(
  status: number,
  message: string,
  type = 'gateway_error',
): Response {
  return json(
    {
      error: {
        message,
        type,
      },
    },
    { status },
  );
}

export function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('content-length');
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  return headers;
}

export async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

export function queryStringNumber(
  url: URL,
  key: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = url.searchParams.get(key);
  const value = raw ? Number(raw) : fallback;
  const normalized = Number.isFinite(value) ? value : fallback;
  const withMin = options.min !== undefined ? Math.max(options.min, normalized) : normalized;
  return options.max !== undefined ? Math.min(options.max, withMin) : withMin;
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
}
