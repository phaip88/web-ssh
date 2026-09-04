# WebSSH Agent Console

**English** · [中文说明](README_CN.md)

Browser-based SSH terminal with a **policy-controlled AI agent**. Everything the
agent does goes through a declared tool registry, a shell-aware command policy
engine, human approval and a tamper-evident audit log.

> Status: **working vertical slice** (login → hosts/credentials → Web SSH → AI
> analysis → approval → execution → audit) plus data model, validation and
> deployment scaffolding for the remaining modules. See "What is implemented"
> and "Remaining work" below – nothing is claimed that is not in the code.

## Quick start (local)

```bash
cp .env.example .env                     # dev defaults; APP_MASTER_KEY may stay empty in development
docker compose -f docker-compose.dev.yml up -d postgres   # or use any PostgreSQL 16
npm ci
npx drizzle-kit push                     # create schema
npx tsx scripts/seed.ts                  # tenant, users, mock hosts, mock LLM provider, audit triggers
npm run dev                              # http://localhost:3000  (mock SSH server starts on 127.0.0.1:2222)
```

Seed accounts (development only – change/remove before any real deployment):

| user | password | role |
|---|---|---|
| admin@example.com | ChangeMe-Admin-2026 | org owner / workspace admin / platform admin |
| dev@example.com | ChangeMe-Dev-2026 | developer (no production access) |
| auditor@example.com | ChangeMe-Dev-2026 | auditor (audit + recordings only) |

Walkthrough: **Terminal** → click `mock-web-01 (dev)` → type `tail -n 5 /var/log/app/app.log` →
in the right panel ask *"Analyze the latest errors in the app log"* → the agent proposes
`terminal.execute` → an approval dialog shows host / command / risk / findings / rollback →
approve → output is executed on a separate exec channel and summarised → **Audit Log** shows
`agent.tool.requested`, `approval.approved`, `agent.tool.executed` with a verifiable hash chain.
Try `mock-web-01 (production)` to see strict host-key approval, or ask *"wipe the disk"* to see a
hard block (`SYSTEM_PATH_DELETE`).

## Commands

| task | command |
|---|---|
| dev server | `npm run dev` |
| typecheck / lint | `npx tsc --noEmit` / `npm run lint` |
| unit + integration tests | `npx vitest run` |
| schema push | `npx drizzle-kit push` |
| seed | `npx tsx scripts/seed.ts` |
| production build | `npm run build && npm start` |

## What is implemented (verified by tests / smoke run)

- **Auth & tenancy**: local accounts (scrypt), HttpOnly/SameSite cookie sessions, lockout, Origin-based CSRF guard, orgs → workspaces → members, RBAC (7 roles) + ABAC (production environment, R4 never auto).
- **SSH**: host CRUD (labels, env, favourites, import/export JSON), envelope-encrypted credentials (AES-256-GCM, per-record DEK, AAD-bound), strict host-key policy with first-connection approval + mismatch alerting, TOFU option, keepalive/timeouts/max duration, idle timeout, per-user/node limits.
- **Terminal gateway**: ssh2 shells, protocol envelope (`v/id/ts/sessionId/type`), SSE output with ring-buffer resume (`?since=seq`), POST input/resize/signal/heartbeat, back-pressure (pauses SSH stream), message size limits, append-only recordings distinguishing `output/input/ai_suggestion/ai_exec/approval` with password-prompt redaction, replay UI, admin terminate.
- **Agent**: modes ask/suggest/approval/auto/plan (default approval), tool registry with JSON Schemas/risk/timeouts/output caps, shell AST policy engine (R0–R4, pipes, redirects, sudo, encodings, exfil, audit bypass…), approvals table with TTL, resume-after-decision, context builder with token budget/sliding window/summary/memories/redaction, usage accounting.
- **Provider gateway**: adapter interface; Mock, OpenAI-compatible (OpenAI/Azure/Ollama/vLLM/custom, streaming + tool calls), Anthropic; SSRF guard (scheme, private/link-local/metadata, DNS resolution, redirect re-validation); encrypted API keys; circuit breaker; retries with backoff.
- **Audit**: hash-chained rows, PostgreSQL triggers rejecting UPDATE/DELETE, chain verification endpoint, CSV export, filters.
- **Extensions (validation layer)**: Skill manifest / MCP config / plugin manifest schemas with security invariants, 3 example skills, DB tables for registries.
- **Ops**: Dockerfile (distroless, non-root, read-only FS), compose dev/prod (Caddy TLS), Helm chart (HPA/PDB/NetworkPolicy/migration Job/security contexts), CI (lint, tsc, tests, migration, gitleaks, CodeQL, Trivy, SBOM, cosign), Renovate, pre-commit.

## Remaining work (priority order)

1. Skill/MCP/plugin **runtimes** (containerised stdio MCP client, skill sandbox, plugin host) – schemas, tables and policy hooks exist; execution does not.
2. SFTP file manager + AI file-edit flow (read → diff → approve → backup → atomic write).
3. Workflow engine (YAML definitions, dry-run, fan-out, rollback) – table exists only.
4. MFA (TOTP/WebAuthn), OIDC/SAML/LDAP, device management.
5. Redis-backed rate limits + session routing for multi-node; WebSocket transport (protocol already defined).
6. pgvector memory retrieval, embeddings, knowledge documents.
7. OpenTelemetry/Prometheus metrics endpoint, SIEM webhooks, Syslog.
8. Playwright E2E suite (API-level E2E is covered by the smoke script in CI).
9. Batch execution across hosts, port forwarding (schema flags exist; disabled by default).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) · [THREAT_MODEL.md](THREAT_MODEL.md)
- [DEPLOYMENT.md](DEPLOYMENT.md) · [DEVELOPMENT.md](DEVELOPMENT.md)
- [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) · [docs/openapi.yaml](docs/openapi.yaml)
- [docs/SKILL_SDK.md](docs/SKILL_SDK.md) · [docs/MCP.md](docs/MCP.md) · [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md)
- [docs/RUNBOOK.md](docs/RUNBOOK.md) (troubleshooting, backup/restore, production checklist)
