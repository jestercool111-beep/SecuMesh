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
import { errorResponse, html, json, queryStringNumber, readJson } from './utils/http.ts';

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

function isAuthorized(request: Request, config: AppConfig): boolean {
  if (config.internalApiKeys.size === 0) {
    return true;
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return Boolean(token) && config.internalApiKeys.has(token);
}

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
    timestamp: new Date(context.startedAt).toISOString(),
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
      if (!isAuthorized(request, appConfig)) {
        return errorResponse(401, 'Unauthorized.', 'invalid_api_key');
      }
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
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      });

      return json(result);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/admin/audit/')) {
      if (!isAuthorized(request, appConfig)) {
        return errorResponse(401, 'Unauthorized.', 'invalid_api_key');
      }
      if (!auditRepository) {
        return errorResponse(503, 'Audit repository is not configured.', 'audit_unavailable');
      }

      const requestId = decodeURIComponent(url.pathname.slice('/admin/audit/'.length));
      if (!requestId || requestId === 'ui') {
        return errorResponse(404, 'Not found.', 'not_found');
      }

      const event = await auditRepository.getByRequestId(requestId);
      if (!event) {
        return errorResponse(404, `Audit event ${requestId} was not found.`, 'audit_not_found');
      }

      return json(event);
    }

    if (request.method === 'GET' && url.pathname === '/admin/audit-ui') {
      return html(renderAuditPage());
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

function renderAuditPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SecuMesh Audit Viewer</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f2f8fb;
        --panel: #ffffff;
        --text: #0f172a;
        --muted: #475569;
        --line: #dbe5ee;
        --accent: #0f766e;
        --danger: #b91c1c;
        --ok: #166534;
        --warn: #9a3412;
        --bad: #991b1b;
        --mono: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      }
      body {
        margin: 0;
        font-family: "Avenir Next", "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", sans-serif;
        background: radial-gradient(circle at 0% 0%, #dff4f0 0%, #f2f8fb 40%, #e7f1f8 100%);
        color: var(--text);
      }
      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 30px;
      }
      p {
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(420px, 1fr) minmax(320px, 0.9fr);
        gap: 14px;
      }
      form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 14px;
      }
      input, button, select {
        border-radius: 12px;
        border: 1px solid var(--line);
        padding: 10px 12px;
        font: inherit;
        background: #fff;
      }
      button {
        background: var(--accent);
        color: white;
        border: none;
        cursor: pointer;
        margin-top: auto;
      }
      .actions {
        display: flex;
        gap: 8px;
        align-items: end;
      }
      .ghost {
        background: #eff6ff;
        color: #1e3a8a;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .chips button {
        padding: 6px 10px;
        margin-top: 0;
        border-radius: 999px;
        background: #ecfeff;
        color: #155e75;
      }
      .results {
        margin-top: 18px;
        display: grid;
        gap: 12px;
      }
      .item {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        background: white;
        transition: border-color 120ms ease, box-shadow 120ms ease;
        cursor: pointer;
      }
      .item:hover {
        border-color: #7dd3fc;
        box-shadow: 0 6px 18px rgba(14, 116, 144, 0.12);
      }
      .item.active {
        border-color: #0ea5e9;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        font-size: 13px;
        color: var(--muted);
      }
      .meta strong {
        color: var(--text);
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
      }
      .status-ok {
        background: #dcfce7;
        color: var(--ok);
      }
      .status-warn {
        background: #ffedd5;
        color: var(--warn);
      }
      .status-bad {
        background: #fee2e2;
        color: var(--bad);
      }
      pre {
        margin: 10px 0 0;
        padding: 12px;
        background: #f8fafc;
        border-radius: 12px;
        overflow: auto;
        font-family: var(--mono);
        font-size: 12px;
      }
      .error {
        color: var(--danger);
      }
      .detail {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        background: #fcfdff;
        min-height: 180px;
      }
      .summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      .summary span {
        padding: 4px 10px;
        border-radius: 999px;
        background: #ecfeff;
        color: #155e75;
        font-size: 12px;
      }
      .hint {
        color: var(--muted);
        font-size: 13px;
      }
      @media (max-width: 980px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Audit Viewer</h1>
        <p>Query gateway audit records and inspect one request in detail.</p>
        <form id="filters">
          <label>Limit<input name="limit" type="number" value="20" min="1" max="200" /></label>
          <label>Status<input name="status" type="number" placeholder="200" /></label>
          <label>Model<input name="model" placeholder="openai/gpt-3.5-turbo" /></label>
          <label>Session ID<input name="sessionId" placeholder="audit-test-001" /></label>
          <label>Request ID<input name="requestId" placeholder="request id" /></label>
          <label>From<input name="from" type="datetime-local" /></label>
          <label>To<input name="to" type="datetime-local" /></label>
          <div class="actions">
            <button type="submit">Search</button>
            <button type="button" class="ghost" id="resetBtn">Reset</button>
          </div>
        </form>
        <div class="chips">
          <button type="button" data-range="15m">Last 15m</button>
          <button type="button" data-range="1h">Last 1h</button>
          <button type="button" data-range="24h">Last 24h</button>
          <button type="button" data-range="7d">Last 7d</button>
        </div>
        <p id="status"></p>
        <div id="summary" class="summary"></div>
        <div class="grid">
          <div id="results" class="results"></div>
          <div class="detail">
            <h3 style="margin:0 0 8px;">Request Detail</h3>
            <p id="detailHint" class="hint">Click a record on the left to load its detail.</p>
            <pre id="detailPre" style="display:none;"></pre>
          </div>
        </div>
      </div>
    </div>
    <script>
      const form = document.getElementById('filters');
      const results = document.getElementById('results');
      const statusEl = document.getElementById('status');
      const summaryEl = document.getElementById('summary');
      const detailHintEl = document.getElementById('detailHint');
      const detailPreEl = document.getElementById('detailPre');
      const resetBtn = document.getElementById('resetBtn');
      const chips = Array.from(document.querySelectorAll('[data-range]'));
      const storageKey = 'secumesh_audit_filters_v1';
      let activeRequestId = '';

      function toIsoLocal(value) {
        return value ? new Date(value).toISOString() : '';
      }

      function statusClass(code) {
        if (code >= 200 && code < 300) return 'status-ok';
        if (code >= 400 && code < 500) return 'status-warn';
        return 'status-bad';
      }

      function collectFilterData() {
        const data = new FormData(form);
        const out = {};
        for (const [key, value] of data.entries()) {
          if (!value) continue;
          out[key] = String(value);
        }
        return out;
      }

      function fillFilters(values) {
        for (const [key, value] of Object.entries(values || {})) {
          const node = form.elements.namedItem(key);
          if (node && typeof node.value === 'string') {
            node.value = value;
          }
        }
      }

      function saveFilters() {
        localStorage.setItem(storageKey, JSON.stringify(collectFilterData()));
      }

      function loadFilters() {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        try {
          fillFilters(JSON.parse(raw));
        } catch {
          localStorage.removeItem(storageKey);
        }
      }

      function setDetailState(text, isError = false) {
        detailPreEl.style.display = 'none';
        detailHintEl.style.display = '';
        detailHintEl.textContent = text;
        detailHintEl.className = isError ? 'hint error' : 'hint';
      }

      function renderSummary(payload) {
        const items = payload.items || [];
        const byStatus = { ok: 0, warn: 0, bad: 0 };
        for (const item of items) {
          if (item.status >= 200 && item.status < 300) byStatus.ok++;
          else if (item.status >= 400 && item.status < 500) byStatus.warn++;
          else byStatus.bad++;
        }
        summaryEl.innerHTML = '';
        const tags = [
          'Count: ' + (payload.count || 0),
          '2xx: ' + byStatus.ok,
          '4xx: ' + byStatus.warn,
          '5xx/other: ' + byStatus.bad,
        ];
        for (const tag of tags) {
          const el = document.createElement('span');
          el.textContent = tag;
          summaryEl.appendChild(el);
        }
      }

      async function loadDetail(requestId) {
        activeRequestId = requestId;
        setDetailState('Loading detail for ' + requestId + ' ...');
        const response = await fetch('/admin/audit/' + encodeURIComponent(requestId), {
          headers: {
            authorization: localStorage.getItem('secumesh_admin_auth') || '',
          },
        });
        if (!response.ok) {
          const body = await response.text();
          setDetailState('Failed to load detail: ' + body, true);
          return;
        }
        const payload = await response.json();
        detailHintEl.style.display = 'none';
        detailPreEl.style.display = '';
        detailPreEl.textContent = JSON.stringify(payload.item || payload, null, 2);
      }

      function renderItems(payload) {
        results.innerHTML = '';
        renderSummary(payload);
        statusEl.textContent = 'Showing ' + payload.count + ' item(s) from ' + payload.source;
        if (!payload.items || payload.items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'item';
          empty.innerHTML = '<div class="hint">No records found with current filters.</div>';
          results.appendChild(empty);
          return;
        }
        for (const item of payload.items) {
          const card = document.createElement('div');
          card.className = 'item';
          card.innerHTML =
            '<div class="meta">' +
            '<span><strong>requestId:</strong> ' + item.requestId + '</span>' +
            '<span><strong>status:</strong> <span class="status-badge ' + statusClass(item.status || 0) + '">' + item.status + '</span></span>' +
            '<span><strong>model:</strong> ' + (item.model || '-') + '</span>' +
            '<span><strong>session:</strong> ' + (item.sessionId || '-') + '</span>' +
            '<span><strong>latency:</strong> ' + (item.durationMs || 0) + 'ms</span>' +
            '<span><strong>timestamp:</strong> ' + (item.timestamp || '-') + '</span>' +
            '</div>';
          card.addEventListener('click', () => {
            for (const n of results.children) n.classList.remove('active');
            card.classList.add('active');
            loadDetail(item.requestId);
          });
          if (activeRequestId && item.requestId === activeRequestId) {
            card.classList.add('active');
          }
          results.appendChild(card);
        }
      }

      function applyRange(range) {
        const now = new Date();
        const from = new Date(now);
        if (range === '15m') from.setMinutes(from.getMinutes() - 15);
        else if (range === '1h') from.setHours(from.getHours() - 1);
        else if (range === '24h') from.setDate(from.getDate() - 1);
        else if (range === '7d') from.setDate(from.getDate() - 7);
        form.elements.namedItem('to').value = now.toISOString().slice(0, 16);
        form.elements.namedItem('from').value = from.toISOString().slice(0, 16);
      }

      async function runQuery(event) {
        if (event) event.preventDefault();
        const data = new FormData(form);
        const params = new URLSearchParams();
        for (const [key, value] of data.entries()) {
          if (!value) continue;
          if (key === 'from' || key === 'to') {
            params.set(key, toIsoLocal(value));
          } else {
            params.set(key, value);
          }
        }
        saveFilters();

        const response = await fetch('/admin/audit?' + params.toString(), {
          headers: {
            authorization: localStorage.getItem('secumesh_admin_auth') || '',
          },
        });

        if (response.status === 401) {
          const token = window.prompt('Paste Authorization header value, e.g. Bearer internal-demo-key');
          if (token) {
            localStorage.setItem('secumesh_admin_auth', token);
            return runQuery();
          }
        }

        if (!response.ok) {
          const body = await response.text();
          statusEl.textContent = body;
          statusEl.className = 'error';
          return;
        }

        statusEl.className = '';
        const payload = await response.json();
        renderItems(payload);
        if (payload.items && payload.items.length > 0) {
          if (!activeRequestId || !payload.items.some((it) => it.requestId === activeRequestId)) {
            activeRequestId = payload.items[0].requestId;
          }
          await loadDetail(activeRequestId);
          for (const n of results.children) {
            if (n.textContent && n.textContent.includes(activeRequestId)) {
              n.classList.add('active');
              break;
            }
          }
        } else {
          activeRequestId = '';
          setDetailState('Click a record on the left to load its detail.');
        }
      }

      chips.forEach((chip) => {
        chip.addEventListener('click', () => {
          applyRange(chip.dataset.range);
          runQuery();
        });
      });
      resetBtn.addEventListener('click', () => {
        form.reset();
        form.elements.namedItem('limit').value = '20';
        localStorage.removeItem(storageKey);
        activeRequestId = '';
        setDetailState('Click a record on the left to load its detail.');
        runQuery();
      });
      form.addEventListener('submit', runQuery);
      loadFilters();
      runQuery();
    </script>
  </body>
</html>`;
}
