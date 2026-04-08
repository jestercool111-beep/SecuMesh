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
- Extension points for PostgreSQL, Redis, Kafka and future billing/console modules

## Quick start

1. Copy `.env.example` to `.env`.
2. Set `UPSTREAM_BASE_URL` to your One API endpoint.
3. Set `INTERNAL_API_KEYS` for chat traffic and `ADMIN_API_KEYS` for `/admin/*` access.
4. For production-style runs, set `SESSION_STORE_DRIVER=redis`.
5. Run `deno task dev`.

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

## Configuration Validation

SecuMesh now validates configuration at startup.

Startup behavior:

- invalid critical settings cause the process to exit immediately
- risky but usable dev-style settings are reported as warnings

Common examples:

- missing or invalid `UPSTREAM_BASE_URL` produces a warning or startup error depending on format
- `SESSION_STORE_DRIVER=redis` requires a valid `REDIS_URL`
- empty `INTERNAL_API_KEYS` means chat traffic is not authenticated
- empty `ADMIN_API_KEYS` falls back to `INTERNAL_API_KEYS` for admin protection

Recommended production baseline:

- set `UPSTREAM_BASE_URL`
- set `INTERNAL_API_KEYS`
- set `ADMIN_API_KEYS`
- set `SESSION_STORE_DRIVER=redis`
- set `REDIS_URL`
- set `AUDIT_LOG_PATH`

## Docker Compose Deployment

The repository now includes a root-level [`compose.yaml`](compose.yaml) for containerized
deployment.

Default services:

- `secumesh`
- `redis`
- `postgres`
- `kafka`
- `worker`

Optional service:

- `one-api` via the `full` profile

Typical usage:

```sh
cp .env.example .env
docker compose up -d --build
```

If One API is already running outside Docker on the host machine:

- set `UPSTREAM_BASE_URL=http://host.docker.internal:3000` on macOS
- or point `UPSTREAM_BASE_URL` to the reachable host/IP for your environment

If you want to start One API inside the same compose stack:

```sh
docker compose --profile full up -d --build
```

In compose mode, use service names for internal traffic:

- `UPSTREAM_BASE_URL=http://one-api:3000`
- `REDIS_URL=redis://redis:6379/0`
- `POSTGRES_URL=postgres://secumesh:secumesh@postgres:5432/secumesh`
- `KAFKA_BROKER=kafka:9092`

Important note:

- inside a container, `localhost` refers to that container itself, not your host machine

Health checks:

- `secumesh` checks `GET /health`
- `redis` checks `redis-cli ping`

Log and data locations:

- gateway audit logs: `./logs`
- One API data: `./one-api/data`
- One API logs: `./one-api/logs`

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
- `ADMIN_API_KEYS=...` to protect admin routes separately from chat traffic
- `ALLOWED_MODELS=...` to enforce approved model usage
- `OUTPUT_BLOCK_TERMS=...` to block or redact unsafe output
- `OUTPUT_BLOCK_MODE=replace` for streaming-friendly enforcement
- `AUDIT_LOG_PATH=logs/audit.jsonl` for durable audit persistence

Operational endpoints:

- `GET /health`: liveness and config summary
- `GET /ready`: readiness check for upstream config, session store, and audit sinks
- `GET /v1/models`: return tenant-visible models
- `GET /admin/audit`: query recent audit records from the JSONL audit file
- `GET /admin/audit/:requestId`: fetch one audit record by request id
- `GET /admin/audit-ui`: minimal in-browser audit viewer
- `GET /compliance/logs`: tenant-scoped compliance query API
- `GET /compliance/logs/:id`: compliance log detail
- `POST /compliance/export`: async compliance export placeholder
- `GET /compliance/summary`: aggregated usage summary
- `GET /api/v1/tenants/me`: current tenant summary
- `GET /api/v1/users`: tenant user list
- `GET /api/v1/api-keys`: API key management
- `GET /api/v1/upstreams`: upstream management

Additional documentation:

- [Integration Guide](docs/integration-guide.md): how chat applications and backend services should
  connect to SecuMesh
- [Roadmap](ROADMAP.md): current implementation roadmap and weekly delivery plan

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
- `src/worker.ts`: MVP worker bridge for future Kafka/PostgreSQL audit pipeline
- `src/app.ts`: route entrypoints and middleware assembly
- `src/config.ts`: runtime configuration
- `src/middleware/`: auth, rate limit, parsing, security, audit
- `src/processors/`: masking and injection checks
- `src/services/`: upstream proxy and audit service
- `src/store/`: session mapping and transient state
- `migrations/`: initial PostgreSQL schema
- `console/`: React + TypeScript + Ant Design console scaffold

## Notes

- The current implementation still supports in-memory masking state for local development.
- Redis session storage is implemented and recommended for production-style deployments.
- PostgreSQL and Kafka are now formal MVP dependencies at the architecture level; the current repo
  includes the schema and local-dev worker bridge.
- ClickHouse remains a planned extension point and is not wired in yet.
- The proxy preserves OpenAI-compatible request and response shapes.
