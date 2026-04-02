# Changelog

All notable changes to SecuMesh will be documented in this file.

This project is currently in the MVP-to-production-ready transition stage. Version entries
focus on delivery milestones rather than strict semantic-versioning guarantees.

## [v0.2.0] - 2026-04-02

This version serves as the pre-refactor baseline for the current SecuMesh MVP.

### Milestone Summary

SecuMesh has moved beyond an initial gateway prototype and now includes the core pieces needed
for a production-oriented MVP:

- secure OpenAI-compatible gateway entrypoint
- sensitive data masking and restoration
- prompt injection checks
- output blocking and replacement policies
- structured audit logging and query APIs
- admin audit UI
- Redis-backed session storage support
- startup config validation
- Docker Compose deployment assets
- integration, roadmap, and sales-facing documentation

This release is the reference point before larger-scale product evolution and architecture
changes begin.

### Added

- `POST /v1/chat/completions` OpenAI-compatible gateway flow
- `/health` and `/ready` operational endpoints
- `/admin/audit` audit query API
- `/admin/audit/:requestId` audit detail API
- `/admin/audit-ui` browser-based audit viewer
- Redis-backed session store support for placeholder persistence
- config validation tests in `src/config_test.ts`
- Docker Compose deployment assets via `compose.yaml`
- sales-facing brochure material in:
  - `docs/sales-brochure-zh.md`
  - `docs/SecuMesh 企业级 AI 安全治理网关.docx`

### Changed

- admin routes now support dedicated admin credentials via `ADMIN_API_KEYS`
- admin UI now uses a formalized login flow rather than unauthenticated shell access
- startup now validates configuration and fails fast on critical errors
- upstream errors are normalized into stable gateway error types
- audit records now include richer fields such as:
  - `user`
  - `upstreamStatus`
  - `errorType`
  - `findingsCount`
- Docker deployment guidance now distinguishes clearly between:
  - local host mode
  - Docker internal service networking
  - optional One API compose profile

### Security and Governance Progress

- internal gateway auth is implemented
- admin auth boundary is separated from general chat access
- CN phone number and PRC ID masking are supported
- prompt injection blocking is available
- output safety policy supports `block` and `replace` modes
- audit logs now better support troubleshooting and governance workflows

### Testing

Automated coverage now includes:

- gateway route behavior
- internal auth
- admin auth
- masking and restoration
- SSE placeholder restoration across chunk boundaries
- output safety enforcement
- audit persistence and audit querying
- configuration validation
- Redis integration flow
- normalized upstream error handling

### Documentation

New or significantly updated documentation includes:

- `README.md`
- `ROADMAP.md`
- `docs/integration-guide.md`
- `docs/sales-brochure-zh.md`

### Operational Notes

- `.env` remains intentionally untracked for local secrets and machine-specific configuration
- `v0.2.0` is the recommended rollback and comparison point before major upcoming changes

## [v0.1.0] - 2026-03-31

Initial MVP baseline.

### Included

- Deno-based gateway skeleton
- OpenAI-compatible chat completions proxy
- base middleware pipeline
- basic masking flow
- prompt injection detection
- file audit logging foundation
- initial tests and local development workflow
