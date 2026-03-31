# SecuMesh AI Security Gateway

This repository contains an MVP Deno gateway for OpenAI-compatible chat completion traffic. It sits
in front of One API or any upstream LLM provider and adds the first layer of enterprise security
controls:

- OpenAI-compatible `/v1/chat/completions` entrypoint
- Middleware-based request pipeline
- Dynamic masking for CN phone numbers and PRC ID numbers
- In-memory session mapping for de-anonymization
- Basic prompt injection detection
- Streaming and non-streaming proxy support
- Async audit hooks with pluggable sinks
- Extension points for Redis and ClickHouse

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `UPSTREAM_BASE_URL` to your One API endpoint.
3. For production-style runs, set `SESSION_STORE_DRIVER=redis`.
4. Run `deno task dev`.

Health check:

```sh
curl http://127.0.0.1:${PORT:-8080}/health
```

Chat request:

```sh
curl http://127.0.0.1:${PORT:-8080}/v1/chat/completions \
  -H "Authorization: Bearer internal-demo-key" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: session-001" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "My phone is 13800138000 and my ID is 11010519491231002X"
      }
    ]
  }'
```

The server now reads values from `.env` automatically, with shell environment variables taking
priority over `.env`.

## Testing

Run the full test suite:

```sh
deno task test
```

Run only the gateway integration tests:

```sh
deno test src/app_test.ts --allow-read
```

Current automated coverage focuses on:

- health check and route behavior
- internal API key auth
- prompt injection blocking
- request masking before upstream forwarding
- response de-anonymization for JSON replies
- SSE streaming restoration across chunk boundaries
- in-memory rate limiting

Redis integration tests:

```sh
deno task test:redis
```

These tests start a temporary local `redis-server`, verify placeholder persistence in Redis, and
exercise the gateway with `SESSION_STORE_DRIVER=redis`.

## MVP Operations

Recommended MVP settings:

- `SESSION_STORE_DRIVER=redis`
- `ALLOWED_MODELS=...` to enforce approved model usage
- `OUTPUT_BLOCK_TERMS=...` to block or redact unsafe output
- `OUTPUT_BLOCK_MODE=replace` for streaming-friendly enforcement
- `AUDIT_LOG_PATH=logs/audit.jsonl` for durable audit persistence

Operational endpoints:

- `GET /health`: liveness and config summary
- `GET /ready`: readiness check for upstream config, session store, and audit sinks
- `GET /admin/audit`: query recent audit records from the JSONL audit file
- `GET /admin/audit/:requestId`: fetch one audit record by request id
- `GET /admin/audit-ui`: minimal in-browser audit viewer

Example audit queries:

```sh
curl "http://127.0.0.1:${PORT:-8080}/admin/audit?limit=20"
curl "http://127.0.0.1:${PORT:-8080}/admin/audit?status=451"
curl "http://127.0.0.1:${PORT:-8080}/admin/audit?model=qwen/qwen-vl-plus"
curl "http://127.0.0.1:${PORT:-8080}/admin/audit?from=2026-03-31T00:00:00.000Z&to=2026-03-31T23:59:59.999Z"
curl "http://127.0.0.1:${PORT:-8080}/admin/audit?requestId=<request-id>"
curl "http://127.0.0.1:${PORT:-8080}/admin/audit/<request-id>"
```

## Project layout

- `src/main.ts`: bootstraps the server
- `src/app.ts`: route entrypoints and middleware assembly
- `src/config.ts`: runtime configuration
- `src/middleware/`: auth, rate limit, parsing, security, audit
- `src/processors/`: masking and injection checks
- `src/services/`: upstream proxy and audit service
- `src/store/`: session mapping and transient state

## Notes

- The current implementation keeps masking state in memory for local development.
- Redis and ClickHouse are modeled as extension points but are not wired in yet.
- The proxy preserves OpenAI-compatible request and response shapes.
