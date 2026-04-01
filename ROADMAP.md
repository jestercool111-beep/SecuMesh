# SecuMesh Roadmap

This document captures the near-term delivery plan for the SecuMesh AI Security Gateway.
It is intended to guide MVP hardening, deployment readiness, and the next round of product
development.

## 1. Current Status

As of 2026-04-01, the project already includes:

- OpenAI-compatible `/v1/chat/completions` gateway entrypoint
- Middleware-based request pipeline
- Internal API key validation
- Prompt injection detection and blocking
- Sensitive data masking and restoration
- Streaming and non-streaming upstream proxy handling
- Redis-backed session store support
- File-based audit logging
- `/health` and `/ready` operational endpoints
- `/admin/audit` query API
- `/admin/audit/:requestId` detail API
- `/admin/audit-ui` minimal audit viewer
- Unit and integration tests for the main gateway flows

This means the project is already beyond pure prototype stage and is now in the
"production-ready MVP" phase.

## 2. Roadmap Goals

The next stage has three primary goals:

1. Make the gateway safe and predictable enough for internal production rollout.
2. Improve operability so deployment, troubleshooting, and auditing are reliable.
3. Prepare the architecture for future scaling without overbuilding too early.

## 3. Phase Plan

### Phase A: Production-Ready MVP

Priority: Highest

Scope:

- Unify admin authentication for `/admin/audit`, `/admin/audit/:requestId`, and `/admin/audit-ui`
- Add startup-time configuration validation for critical environment variables
- Improve audit schema consistency and error classification
- Add deployment-ready Docker Compose setup
- Upgrade documentation to match the actual implementation

Expected outcome:

- A deployable internal gateway with stable admin access, reproducible startup, and
  reliable troubleshooting behavior.

### Phase B: Operational Hardening

Priority: High

Scope:

- Redis-backed rate limiting for multi-instance deployments
- Enhanced audit query filters, sorting, and pagination
- Better admin audit UI with practical debugging workflow
- Metrics endpoint and operational observability
- Stronger model governance with allowlists and routing constraints

Expected outcome:

- A gateway that is easier to operate under real traffic and easier to diagnose when
  upstream issues occur.

### Phase C: Compliance and Scale

Priority: Medium

Scope:

- ClickHouse-backed audit persistence
- Externalized policy configuration
- Expanded masking coverage for more sensitive data types
- Better multi-modal request support
- Review workflow for blocked requests and audit replay

Expected outcome:

- A platform foundation suitable for larger-scale enterprise governance needs.

## 4. Detailed Backlog

### P0: Must Complete Before Internal MVP Rollout

- Admin auth consolidation
  - Introduce a dedicated admin token or equivalent admin auth mechanism
  - Separate gateway client auth from admin viewer/query auth
  - Ensure UI and API behavior are consistent under unauthorized access

- Config validation and fail-fast startup
  - Validate required runtime configuration on boot
  - Return clear startup errors for missing or invalid env vars
  - Distinguish local-dev defaults from production expectations

- Docker Compose deployment
  - Provide a reproducible stack for gateway + Redis + One API connectivity
  - Document host-vs-container network differences clearly
  - Ensure readiness checks align with container startup order

- Audit schema standardization
  - Normalize `timestamp`, `status`, `upstreamStatus`, `errorType`, `requestId`, `sessionId`
  - Add structured metadata for routing and policy findings
  - Ensure blocked and failed requests are still fully auditable

- Upstream error normalization
  - Map One API / OpenRouter / network errors into stable gateway error types
  - Preserve useful diagnostics without leaking internal noise to clients
  - Improve operator visibility in audit records

- Documentation alignment
  - Update README to reflect Redis support already implemented
  - Document admin endpoints, auth model, and deployment modes
  - Add troubleshooting guidance for common upstream routing errors

### P1: Important Shortly After MVP Rollout

- Redis-based distributed rate limiting
- Audit query pagination and sorting
- Better filter combinations for audit search
- Audit UI improvements for analyst workflow
- Metrics and observability endpoint
- Model allowlist and policy routing by environment or user group
- Richer prompt injection detection rules
- Configurable output policy modes and policy dictionaries

### P2: Follow-On Platform Work

- ClickHouse audit sink and repository
- Support for additional sensitive data classes
- Multi-modal masking and audit handling
- Policy center / hot-reloadable rule configuration
- Replay and review workflow for blocked requests
- Horizontal scaling and multi-instance deployment guide

## 5. This Week Task List

The goal for this week is to finish the highest-leverage work needed to make the MVP
deployable and easier to operate.

### Task 1: Admin Authentication Cleanup

Deliverables:

- Define one admin auth mechanism for all `/admin/*` routes
- Update `/admin/audit-ui` to use the same mechanism cleanly
- Add tests for authenticated and unauthenticated admin access

Definition of done:

- Admin APIs and UI no longer rely on ad hoc behavior
- Unauthorized behavior is explicit and documented

### Task 2: Startup Config Validation

Deliverables:

- Add a config validation function
- Surface configuration warnings/errors clearly at boot
- Distinguish required production config from optional dev config

Definition of done:

- Invalid configuration fails early with actionable messages
- `.env.example` and README match runtime expectations

### Task 3: Docker Compose Deployment

Deliverables:

- Add `docker-compose.yml` or equivalent compose file
- Add service definitions for gateway and Redis
- Wire environment variables for One API upstream access
- Document expected ports and hostname behavior

Definition of done:

- A new developer can bring the stack up with one command
- Health and readiness endpoints behave correctly in compose mode

### Task 4: Audit Schema and Error Normalization

Deliverables:

- Standardize audit event fields
- Add explicit error category mapping for upstream failures
- Ensure audit events record enough context to debug failures

Definition of done:

- Audit records are consistent across success, blocked, and failure cases
- Operators can distinguish auth failure, upstream model error, routing error, and network error

### Task 5: README and Operations Documentation Refresh

Deliverables:

- Refresh README to match current feature set
- Add common curl examples for normal flow and admin flow
- Document local mode vs Docker mode
- Add a short troubleshooting section

Definition of done:

- Documentation is sufficient for setup, smoke test, and first-line debugging

## 6. Suggested Execution Order

To reduce rework, the recommended implementation order is:

1. Admin authentication cleanup
2. Config validation
3. Audit schema and error normalization
4. Docker Compose deployment
5. README and operations documentation refresh

This order keeps security and correctness first, then makes deployment reproducible,
then finishes with documentation that matches the final behavior.

## 7. Acceptance Criteria for the MVP Milestone

The MVP should be considered ready for internal rollout when all of the following are true:

- Gateway requests are authenticated and routed reliably
- Redis-backed masking works in the target deployment mode
- Admin audit endpoints are protected and usable
- Audit records are queryable and diagnostically useful
- Compose-based deployment is documented and repeatable
- Health and readiness endpoints reflect real dependency state
- The main request flows are covered by automated tests

## 8. Risks and Dependencies

- One API upstream routing quality remains an external dependency
- Different deployment modes can cause hostname mismatches if not documented carefully
- Audit requirements may grow quickly once internal users start testing
- Multi-model behavior may require provider-specific exception handling over time

## 9. Recommended Next Step

The next concrete implementation sprint should focus on:

1. Admin auth consolidation
2. Config validation
3. Audit schema and error normalization

These items give the best balance of security, operability, and rollout confidence.
