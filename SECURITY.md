# Security

## Principles
Zero trust between components, least privilege for every actor (human, agent,
skill, MCP server), secrets never leave the server, every privileged action is
auditable and attributable.

## Controls implemented

| area | control | where |
|---|---|---|
| Passwords | scrypt (N=16384), policy check, lockout after N failures | `lib/auth/password.ts`, `api/auth/login` |
| Sessions | 256-bit random token, SHA-256 stored, HttpOnly + SameSite=Lax + Secure(prod), revocation | `lib/auth/session.ts` |
| CSRF | Origin/Referer must match Host or `ALLOWED_ORIGINS` on all non-GET | `lib/http.ts#assertSameOrigin` |
| Headers | CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, HSTS (prod) | `src/proxy.ts` |
| Input | zod schemas on every body/query, body size limits, protocol message size limits | route handlers |
| Secrets at rest | AES-256-GCM envelope encryption, per-record DEK, AAD bound to record id, KEK from `APP_MASTER_KEY` (required in production) | `lib/crypto/envelope.ts` |
| Secrets in transit | private keys/passwords are decrypted only inside `buildConnectConfig`, buffers zeroed after connect; API never returns encrypted payloads | `lib/ssh/connect.ts`, `api/credentials` |
| Host keys | strict by default: unknown key → 428 + pending record + explicit approval (`hosts:manage`); changed key → refused + R4 audit | `lib/ssh/connect.ts#buildHostVerifier` |
| Tenant isolation | every query scoped by `resolveWorkspace`; membership verified; RLS policies available | `lib/tenancy.ts`, `drizzle/sql/audit_guard.sql` |
| RBAC/ABAC | 7 roles → 21 permissions; production requires `env:production`; R4 never auto | `lib/auth/rbac.ts` |
| Agent | tool registry only; zod validation; shell-AST policy; hard-block categories; approval TTL; separate exec channel; output caps; redaction | `lib/agent/*`, `lib/policy/*` |
| Prompt injection | system prompt marks terminal/file/tool output as untrusted; tool results are JSON-wrapped; no tool can change mode/permissions | `lib/agent/context.ts` |
| SSRF | scheme allowlist, no credentials in URL, private/link-local/metadata rejection after DNS resolution, redirect re-validation, admin allowlist | `lib/llm/ssrf-guard.ts` |
| Log hygiene | `redactSecrets`/`redactObject` applied to audit metadata, tool outputs, memories; API keys shown as masked tail only | `lib/security/redact.ts` |
| Audit integrity | per-tenant hash chain under advisory lock; triggers reject UPDATE/DELETE; verification endpoint | `lib/audit`, `drizzle/sql/audit_guard.sql` |
| Rate limiting | login per IP, terminal input per user, agent runs per user (in-memory; Redis for multi-node) | `lib/http.ts#rateLimit` |
| Supply chain | lockfile, Renovate, gitleaks, CodeQL, Trivy, SBOM, cosign, distroless non-root image | `.github/workflows/ci.yml`, `Dockerfile` |

## Production requirements (enforced or checked)
- `APP_ENV=production` **refuses to start** without `APP_MASTER_KEY` and `DATABASE_URL` (`instrumentation.ts`).
- Provider base URLs must be HTTPS unless `PROVIDER_ALLOW_HTTP=true`.
- Mock SSH server and demo hints are disabled by default in production (`MOCK_SSH_ENABLED`, `NEXT_PUBLIC_SHOW_DEMO_HINT`).
- Seed script refuses to run in production without `ALLOW_PROD_SEED=true`.
- Cookies are `Secure` in production; terminate TLS at Caddy/Ingress and forward `X-Forwarded-Host`.

## Known gaps (tracked)
- MFA/WebAuthn, OIDC/SAML, break-glass workflow: not implemented.
- Skill/MCP/plugin sandboxes: validation only; do not enable untrusted extensions until runtimes ship.
- Rate limiter and session registry are per-process.
- `npm audit` currently reports transitive advisories in dev tooling; CI runs the audit in report mode. Review before release.

## Reporting
Please report vulnerabilities privately to security@example.com. Do not open public issues for security reports.
