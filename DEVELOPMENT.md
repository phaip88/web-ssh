# Development

## Layout
```
src/app/(app)/*          authenticated pages (dashboard, terminal, hosts, credentials, sessions, providers, audit, settings)
src/app/api/*            route handlers (thin: validate → authorize → lib → respond)
src/lib/agent            runtime.ts (state machine), tools.ts (registry), context.ts (builder), sse.ts
src/lib/policy           shell-parser.ts, command-policy.ts
src/lib/ssh              registry.ts (gateway), connect.ts (host keys + credentials)
src/lib/llm              gateway.ts, adapters/*, ssrf-guard.ts, types.ts
src/lib/mock-ssh         server.ts (ssh2 server), vshell.ts (virtual filesystem shell)
src/lib/extensions       Skill/MCP/plugin manifest schemas
src/components/terminal  xterm view, agent panel, approval dialog, zustand store
tests/unit, tests/integration
skills/*                 example skill manifests
deploy/, .github/        compose, Caddy, Helm, CI
```

## Workflow
1. `docker compose -f docker-compose.dev.yml up -d postgres`
2. `npx drizzle-kit push && npx tsx scripts/seed.ts`
3. `npm run dev`
4. Tests: `npx vitest run` (the integration suite starts the mock SSH server on port 2299).
5. Before pushing: `npx tsc --noEmit && npm run lint && npm run build`.

## Adding an agent tool
Declare it in `src/lib/agent/tools.ts` with zod input, JSON Schema, permission, risk, approval flag, production flag, timeout, output cap and audit fields. If it runs a shell command, provide `toCommand` so the policy engine can analyse the exact command. Add a policy test in `tests/unit/command-policy.test.ts`.

## Adding a provider
Implement `ProviderAdapter` in `src/lib/llm/adapters/`, register the `kind` in `gateway.ts#createAdapter` and in the provider API schema. Use `safeFetch` for all outbound HTTP.

## Conventions
- Strict TypeScript, no `any` (single eslint-disabled cast in the tool array).
- Route files export only HTTP verbs; shared schemas live in `src/lib/schemas`.
- Every mutation calls `audit(...)`; never log raw secrets – use `redactObject`.
- Errors use `ApiError(code, message)`; codes are listed in `docs/openapi.yaml`.
- Subprocesses are not used by the app; the mock shell is virtual.
