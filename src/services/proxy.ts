import type { AppConfig } from '../config.ts';
import { copyResponseHeaders } from '../utils/http.ts';

export interface ProxyResult {
  response?: Response;
  responseText?: string;
  responseBytes?: number;
  status: number;
  headers: Headers;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

function buildUpstreamHeaders(request: Request, config: AppConfig): Headers {
  const headers = new Headers();

  const incomingHeaders = [
    'content-type',
    'accept',
    'openai-organization',
    'openai-project',
    'anthropic-version',
    'x-request-id',
  ];

  for (const name of incomingHeaders) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  const explicitAuthorization = request.headers.get('x-upstream-authorization')?.trim();
  const explicitApiKey = request.headers.get('x-upstream-api-key')?.trim();
  const fallbackAuthorization = config.upstreamApiKey
    ? `Bearer ${config.upstreamApiKey}`
    : explicitApiKey
    ? `Bearer ${explicitApiKey}`
    : request.headers.get('authorization') ?? '';

  if (explicitAuthorization) {
    headers.set('authorization', explicitAuthorization);
  } else if (fallbackAuthorization) {
    headers.set('authorization', fallbackAuthorization);
  }

  return headers;
}

export async function forwardChatCompletion(
  request: Request,
  config: AppConfig,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!config.upstreamBaseUrl) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'configuration_error',
          message: 'UPSTREAM_BASE_URL is not configured.',
        },
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  const upstreamUrl = new URL(request.url);
  const targetUrl = new URL(
    upstreamUrl.pathname + upstreamUrl.search,
    withTrailingSlash(config.upstreamBaseUrl),
  );

  return await fetchImpl(targetUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request, config),
    body: JSON.stringify(body),
  });
}

export async function restoreJsonResponse(
  upstreamResponse: Response,
  restoreText: (input: string) => Promise<string>,
): Promise<ProxyResult> {
  const text = await upstreamResponse.text();
  const restoredText = await restoreText(text);
  const usage = parseUsage(restoredText);
  const headers = copyResponseHeaders(upstreamResponse.headers);

  return {
    responseText: restoredText,
    responseBytes: new TextEncoder().encode(restoredText).byteLength,
    status: upstreamResponse.status,
    headers,
    tokenUsage: usage,
  };
}

export function restoreStreamingResponse(
  upstreamResponse: Response,
  restoredStream: ReadableStream<Uint8Array>,
): ProxyResult {
  const headers = copyResponseHeaders(upstreamResponse.headers);
  return {
    status: upstreamResponse.status,
    headers,
    response: new Response(restoredStream, {
      status: upstreamResponse.status,
      headers,
    }),
  };
}

function parseUsage(text: string): ProxyResult['tokenUsage'] {
  try {
    const parsed = JSON.parse(text) as { usage?: Record<string, number> };
    if (!parsed.usage) {
      return undefined;
    }

    return {
      promptTokens: parsed.usage.prompt_tokens,
      completionTokens: parsed.usage.completion_tokens,
      totalTokens: parsed.usage.total_tokens,
    };
  } catch {
    return undefined;
  }
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
