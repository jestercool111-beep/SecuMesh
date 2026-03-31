import type { AppConfig } from './config.ts';
import { compose, type GatewayContext, type Middleware } from './middleware.ts';
import { InjectionChecker } from './processors/injection_checker.ts';
import { OutputPolicyProcessor } from './processors/output_policy_processor.ts';
import { SensitiveProcessor } from './processors/sensitive_processor.ts';
import {
  AuditService,
  ConsoleAuditSink,
  FileAuditRepository,
  FileAuditSink,
} from './services/audit.ts';
import {
  forwardChatCompletion,
  restoreJsonResponse,
  restoreStreamingResponse,
} from './services/proxy.ts';
import { InMemoryRateLimiter } from './services/rate_limiter.ts';
import { createSessionStore } from './store/factory.ts';
import type { SessionStore } from './store/session_store.ts';
import type { ChatCompletionsRequest, SecurityFinding } from './types.ts';
import { errorResponse, json, queryStringNumber, readJson } from './utils/http.ts';

interface CreateHandlerOptions {
  fetchImpl?: typeof fetch;
  auditService?: AuditService;
  sessionStore?: SessionStore;
  auditRepository?: FileAuditRepository;
}

const authMiddleware: Middleware = async (context, next) => {
  if (context.config.internalApiKeys.size === 0) {
    return await next();
  }

  const header = context.request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token || !context.config.internalApiKeys.has(token)) {
    return errorResponse(401, 'Unauthorized.', 'invalid_api_key');
  }

  return await next();
};

const rateLimitMiddleware: Middleware = async (context, next) => {
  const result = context.rateLimiter.check(context.clientIp);
  if (!result.allowed) {
    return errorResponse(429, 'Rate limit exceeded.', 'rate_limit_exceeded');
  }

  const response = await next();
  response.headers.set('x-ratelimit-remaining', String(result.remaining));
  response.headers.set('x-ratelimit-reset', new Date(result.resetAt).toISOString());
  return response;
};

const parseBodyMiddleware: Middleware = async (context, next) => {
  try {
    context.state.requestBody = await readJson<ChatCompletionsRequest>(context.request);
  } catch {
    return errorResponse(400, 'Invalid JSON request body.', 'invalid_request_error');
  }

  const body = context.state.requestBody;
  if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    return errorResponse(
      400,
      'Expected OpenAI-compatible chat completions payload.',
      'invalid_request_error',
    );
  }

  if (
    context.config.allowedModels.size > 0 &&
    !context.config.allowedModels.has(body.model)
  ) {
    context.state.findings.push({
      code: 'MODEL_NOT_ALLOWED',
      message: `Model ${body.model} is not in the approved allowlist.`,
      severity: 'high',
      action: 'block',
    });
    return errorResponse(403, `Model ${body.model} is not allowed.`, 'model_not_allowed');
  }

  context.state.auditMeta.requestBytes = Number(context.request.headers.get('content-length') ?? 0);
  return await next();
};

const securityMiddleware: Middleware = async (context, next) => {
  const body = context.state.requestBody;
  if (!body) {
    return errorResponse(500, 'Request body was not initialized.', 'internal_error');
  }

  const sanitized = await context.sensitiveProcessor.sanitizeRequest(context.sessionId, body);
  context.state.maskedRequestBody = sanitized.body;
  context.state.findings.push(...sanitized.findings);

  const combinedPrompt = sanitized.body.messages
    .map((message) => {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => typeof part.text === 'string' ? part.text : '')
          .join('\n');
      }
      return '';
    })
    .join('\n');

  const injectionFindings = context.injectionChecker.inspect(combinedPrompt);
  context.state.findings.push(...injectionFindings);

  if (
    context.config.blockOnInjection && injectionFindings.some((item) => item.action === 'block')
  ) {
    return errorResponse(400, 'Prompt injection risk detected.', 'prompt_injection_blocked');
  }

  return await next();
};

function createProxyMiddleware(fetchImpl: typeof fetch): Middleware {
  return async (context) => {
    const requestBody = context.state.maskedRequestBody;
    if (!requestBody) {
      return errorResponse(500, 'Masked request body was not initialized.', 'internal_error');
    }

    const upstreamResponse = await forwardChatCompletion(
      context.request,
      context.config,
      requestBody,
      fetchImpl,
    );
    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      if (!upstreamResponse.body) {
        return errorResponse(502, 'Upstream returned an empty stream.', 'upstream_error');
      }

      const restored = await context.sensitiveProcessor.createRestoreStream(
        context.sessionId,
        upstreamResponse.body,
      );
      const filtered = context.outputPolicyProcessor.createFilterStream(restored, (findings) => {
        context.state.findings.push(...findings);
      });
      const proxyResult = restoreStreamingResponse(upstreamResponse, filtered);
      if (!proxyResult.response) {
        return errorResponse(
          502,
          'Upstream returned an invalid stream response.',
          'upstream_error',
        );
      }
      proxyResult.response.headers.set('x-request-id', context.requestId);
      proxyResult.response.headers.set('x-session-id', context.sessionId);
      return proxyResult.response;
    }

    const proxyResult = await restoreJsonResponse(
      upstreamResponse,
      async (text) => await context.sensitiveProcessor.restoreText(context.sessionId, text),
    );
    const outputResult = context.outputPolicyProcessor.enforceText(proxyResult.responseText ?? '');
    context.state.findings.push(...outputResult.findings);
    context.state.auditMeta.responseBytes = new TextEncoder().encode(outputResult.text).byteLength;
    context.state.auditMeta.tokenUsage = proxyResult.tokenUsage ?? {};

    if (outputResult.blocked) {
      return errorResponse(
        451,
        'Response blocked by output safety policy.',
        'output_blocked',
      );
    }

    const response = new Response(outputResult.text, {
      status: proxyResult.status,
      headers: proxyResult.headers,
    });
    response.headers.set('x-request-id', context.requestId);
    response.headers.set('x-session-id', context.sessionId);
    return response;
  };
}

const auditMiddleware: Middleware = async (context, next) => {
  let response: Response;

  try {
    response = await next();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    response = errorResponse(500, message, 'internal_error');
  }

  const durationMs = Date.now() - context.startedAt;
  context.auditService.emit({
    requestId: context.requestId,
    sessionId: context.sessionId,
    route: new URL(context.request.url).pathname,
    method: context.request.method,
    clientIp: context.clientIp,
    model: context.state.requestBody?.model,
    status: response.status,
    durationMs,
    stream: Boolean(context.state.requestBody?.stream),
    requestBytes: Number(context.state.auditMeta.requestBytes ?? 0),
    responseBytes: Number(context.state.auditMeta.responseBytes ?? 0),
    tokenUsage: context.state.auditMeta.tokenUsage as {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    } | undefined,
    findings: dedupeFindings(context.state.findings),
    meta: {
      upstreamConfigured: Boolean(context.config.upstreamBaseUrl),
    },
  });

  return response;
};

export function createHandler(
  appConfig: AppConfig,
  options: CreateHandlerOptions = {},
): Deno.ServeHandler {
  const sessionStore = options.sessionStore ?? createSessionStore(appConfig);
  const sensitiveProcessor = new SensitiveProcessor(sessionStore);
  const injectionChecker = new InjectionChecker();
  const auditSinks = [];
  if (appConfig.enableConsoleAudit) {
    auditSinks.push(new ConsoleAuditSink());
  }
  if (appConfig.auditLogPath) {
    auditSinks.push(new FileAuditSink(appConfig.auditLogPath));
  }
  const outputPolicyProcessor = new OutputPolicyProcessor(
    appConfig.outputBlockTerms,
    appConfig.outputBlockMode,
  );
  const auditService = options.auditService ?? new AuditService(auditSinks);
  const auditRepository = options.auditRepository ??
    (appConfig.auditLogPath ? new FileAuditRepository(appConfig.auditLogPath) : undefined);
  const rateLimiter = new InMemoryRateLimiter(
    appConfig.rateLimitWindowMs,
    appConfig.rateLimitMaxRequests,
  );
  const proxyMiddleware = createProxyMiddleware(options.fetchImpl ?? fetch);
  const chain = compose([
    auditMiddleware,
    authMiddleware,
    rateLimitMiddleware,
    parseBodyMiddleware,
    securityMiddleware,
    proxyMiddleware,
  ]);

  return async (request, info) => {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        upstreamConfigured: Boolean(appConfig.upstreamBaseUrl),
        sessionStoreDriver: appConfig.sessionStoreDriver,
        auditLogPath: appConfig.auditLogPath,
        allowlistEnabled: appConfig.allowedModels.size > 0,
      });
    }

    if (request.method === 'GET' && url.pathname === '/ready') {
      const sessionStoreHealth = await sessionStore.healthCheck();
      const auditHealth = await auditService.healthCheck();
      const dependencies = [
        {
          name: 'upstream',
          ok: Boolean(appConfig.upstreamBaseUrl),
          details: appConfig.upstreamBaseUrl ? undefined : 'UPSTREAM_BASE_URL is not configured.',
        },
        {
          name: `session_store:${sessionStoreHealth.driver}`,
          ok: sessionStoreHealth.ok,
          details: sessionStoreHealth.details,
        },
        ...auditHealth.sinks.map((sink) => ({
          name: `audit_sink:${sink.name}`,
          ok: sink.ok,
          details: sink.details,
        })),
      ];
      const ready = dependencies.every((item) => item.ok);

      return json(
        {
          status: ready ? 'ready' : 'degraded',
          dependencies,
        },
        { status: ready ? 200 : 503 },
      );
    }

    if (request.method === 'GET' && url.pathname === '/admin/audit') {
      if (!auditRepository) {
        return errorResponse(503, 'Audit repository is not configured.', 'audit_unavailable');
      }

      const limit = queryStringNumber(url, 'limit', 50, { min: 1, max: 200 });
      const statusRaw = url.searchParams.get('status');
      const status = statusRaw ? Number(statusRaw) : undefined;

      const result = await auditRepository.query({
        limit,
        requestId: url.searchParams.get('requestId') ?? undefined,
        sessionId: url.searchParams.get('sessionId') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
        status: Number.isFinite(status) ? status : undefined,
      });

      return json(result);
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return errorResponse(404, 'Not found.', 'not_found');
    }

    const requestId = crypto.randomUUID();
    const sessionId = request.headers.get('x-session-id')?.trim() || requestId;
    const clientIp = info.remoteAddr.transport === 'tcp' ? info.remoteAddr.hostname : 'unknown';

    const context: GatewayContext = {
      request,
      config: appConfig,
      auditService,
      sensitiveProcessor,
      injectionChecker,
      outputPolicyProcessor,
      rateLimiter,
      sessionStore,
      requestId,
      sessionId,
      clientIp,
      startedAt: Date.now(),
      state: {
        findings: [],
        auditMeta: {},
      },
    };

    return await chain(context, async () => errorResponse(500, 'Pipeline terminated early.'));
  };
}

function dedupeFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.message}:${finding.action}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
