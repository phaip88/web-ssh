# Architecture

## Deployment topology (current)

A single Next.js 16 process hosts the control plane, the SSH gateway and the
agent runtime; PostgreSQL is the system of record. This keeps the vertical slice
small; module boundaries are enforced in code (`src/lib/*`) so the gateway and
agent runtime can be extracted into separate services (Go gateway / Python
FastAPI runtime) without touching the HTTP layer.

```
Browser ──HTTPS──▶ proxy.ts (headers, redirects)
                    │
                    ├─ /api/auth,/api/hosts,… ─▶ lib/auth (session, RBAC/ABAC) ─▶ Drizzle ─▶ PostgreSQL
                    ├─ /api/terminal/sessions ─▶ lib/ssh/registry (ssh2 clients, ring buffers, recordings)
                    │        └─ SSE stream ◀── LiveSession subscribers (back-pressure)
                    ├─ /api/agent/*,/api/approvals ─▶ lib/agent/runtime ─▶ tools ─▶ policy ─▶ approvals
                    │        └─ lib/llm/gateway ─▶ adapters (mock/openai-compatible/anthropic) ─▶ safeFetch (SSRF guard)
                    └─ every mutation ─▶ lib/audit (hash chain, advisory lock)
instrumentation.ts ─▶ mock SSH server (dev only) · production config guard
```

## Modules and boundaries

| module | path | responsibility | must not |
|---|---|---|---|
| HTTP transport | `src/app/api/**`, `src/lib/http.ts` | schema validation, auth wiring, error codes | contain business rules |
| Auth | `src/lib/auth/*` | sessions, passwords, RBAC/ABAC | read secrets |
| Tenancy | `src/lib/tenancy.ts` | workspace scope resolution + membership check | – |
| Crypto | `src/lib/crypto/envelope.ts` | envelope encryption, KEK loading | log plaintext |
| SSH gateway | `src/lib/ssh/*` | connections, host keys, shells, exec channels, recordings | evaluate policy |
| Policy engine | `src/lib/policy/*` | shell AST, risk classification, decisions | perform I/O |
| Agent runtime | `src/lib/agent/*` | run state machine, tool registry, context builder | call ssh2 directly (uses registry API) |
| Provider gateway | `src/lib/llm/*` | adapters, SSRF guard, breaker, usage | know about hosts/sessions |
| Audit | `src/lib/audit` | append-only, hash-chained events | throw into request path |
| Extensions | `src/lib/extensions/manifests.ts` | Skill/MCP/plugin manifest validation | execute code |

## Data flow: "analyse this error and fix it"

1. Browser POSTs `agent.message` → `startRun` stores the user message and audits `agent.run.started`.
2. `buildContext` assembles system policy + host facts + redacted terminal tail + memories + windowed history within `contextWindow − maxOutputTokens`.
3. Provider adapter streams deltas (`agent.delta`) and returns tool calls.
4. For each call: registry lookup → zod input validation → `evaluateTool` (RBAC + production ABAC + `decideCommand`) → `agent_tool_calls` row → audit `agent.tool.requested`.
   - `blocked` → refusal is fed back to the model as a tool result.
   - `approval_required` → `approvals` row (TTL), run → `waiting_approval`, `approval.required` emitted, stream ends.
   - `allow` → executed on a dedicated **exec channel** of the same SSH connection (never typed into the user's shell), output capped/redacted, audit `agent.tool.executed`.
5. `POST /api/approvals/{id}/decide` → audit `approval.approved|rejected` → execute or reject → `loop` continues on a new SSE stream.

## Trust boundaries

| boundary | control |
|---|---|
| Browser ↔ API | HttpOnly SameSite cookie, Origin check on mutations, CSP/XFO/nosniff, body limits, rate limits |
| API ↔ database | tenant scope on every query (`resolveWorkspace`), optional RLS policies (`drizzle/sql/audit_guard.sql`) |
| API ↔ SSH hosts | credential decrypted only inside `buildConnectConfig`, zeroed after handshake; strict host keys; per-host timeouts |
| Model ↔ tools | tool registry + policy engine + approvals; model output and terminal data are untrusted |
| API ↔ LLM providers | SSRF guard, HTTPS in production, encrypted keys, redaction before send |
| Audit | DB triggers reject UPDATE/DELETE; hash chain verifiable via `GET /api/audit?verify=true` |

## Failure isolation

- SSH client errors close only that session (`closeSession`), audited with reason.
- Provider failures trip a per-provider circuit breaker (5 failures → 60 s open); runs fail closed.
- Audit write failures are logged loudly but never break the request (availability of the control plane) – in a hardened deployment route audit to an outbox table + external sink.
- Node capacity limits (`MAX_SESSIONS_PER_NODE`) and per-user limits stop a single tenant from exhausting a gateway.

## Scaling path

- Session state lives on one node (`terminal_sessions.node_id`). Route by cookie affinity (Helm values do this) or move the registry into a dedicated gateway with Redis for presence.
- Replace `rateLimit` in `lib/http.ts` with a Redis token bucket.
- Split the agent runtime into a worker consuming `agent_runs` via NATS/Redis Streams; the SSE emitter interface (`Emit`) already decouples it from HTTP.

## Database

`src/db/schema.ts` defines 40 tables covering identity, tenancy, SSH, terminal
sessions/events, agent conversations/runs/tool calls/approvals, providers,
usage, memories, skills, MCP, plugins, workflows, artifacts, policies,
notifications and audit. Conventions: UUID PKs, `org_id` on every tenant table,
`created_at/updated_at`, `deleted_at` only where soft-delete makes sense,
`version` for optimistic locking on mutable config, append-only event tables
with `bigserial`.
