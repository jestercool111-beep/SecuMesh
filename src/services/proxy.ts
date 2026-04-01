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

interface NormalizedGatewayError {
  status: number;
  type: string;
  message: string;
  upstreamStatus?: number;
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

  try {
    const upstreamResponse = await fetchImpl(targetUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, config),
      body: JSON.stringify(body),
    });
    return await normalizeUpstreamResponse(upstreamResponse);
  } catch (error) {
    return createGatewayErrorResponse({
      status: 502,
      type: 'upstream_connection_error',
      message: error instanceof Error ? error.message : 'Failed to reach upstream provider.',
    });
  }
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

async function normalizeUpstreamResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }

  const contentType = response.headers.get('content-type') ?? '';
  let message = `Upstream request failed with status ${response.status}.`;
  let upstreamErrorType = '';

  if (contentType.includes('application/json')) {
    try {
      const payload = await response.clone().json() as {
        error?: {
          message?: string;
          type?: string;
          code?: string | number;
        };
      };
      if (payload.error?.message) {
        message = payload.error.message;
      }
      if (payload.error?.type) {
        upstreamErrorType = String(payload.error.type);
      }
    } catch {
      // Ignore parse failures and keep the default message.
    }
  } else {
    try {
      const text = (await response.clone().text()).trim();
      if (text) {
        message = text;
      }
    } catch {
      // Ignore body read failures and keep the default message.
    }
  }

  return createGatewayErrorResponse({
    status: mapGatewayStatus(response.status),
    type: mapGatewayErrorType(response.status, message, upstreamErrorType),
    message,
    upstreamStatus: response.status,
  });
}

function createGatewayErrorResponse(error: NormalizedGatewayError): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-secumesh-error-type': error.type,
  });
  if (error.upstreamStatus !== undefined) {
    headers.set('x-secumesh-upstream-status', String(error.upstreamStatus));
  }

  return new Response(
    JSON.stringify({
      error: {
        message: error.message,
        type: error.type,
      },
    }),
    {
      status: error.status,
      headers,
    },
  );
}

function mapGatewayStatus(upstreamStatus: number): number {
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return 502;
  }
  if (upstreamStatus === 404) {
    return 404;
  }
  if (upstreamStatus === 429) {
    return 429;
  }
  return 502;
}

function mapGatewayErrorType(
  upstreamStatus: number,
  message: string,
  upstreamErrorType: string,
): string {
  const normalized = `${upstreamErrorType} ${message}`.toLowerCase();

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return 'upstream_auth_error';
  }
  if (upstreamStatus === 429) {
    return 'upstream_rate_limited';
  }
  if (upstreamStatus === 404) {
    if (normalized.includes('no endpoints found') || normalized.includes('无可用渠道')) {
      return 'upstream_route_not_found';
    }
    if (normalized.includes('model')) {
      return 'upstream_model_not_found';
    }
    return 'upstream_not_found';
  }
  if (normalized.includes('timeout')) {
    return 'upstream_timeout';
  }
  return 'upstream_error';
}
