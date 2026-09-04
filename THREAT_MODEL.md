# Threat Model (STRIDE, condensed)

Assets: SSH credentials, host keys, terminal recordings, LLM API keys, audit log, tenant data, the ability to execute commands on managed hosts.

| # | threat | actor | vector | mitigations | residual risk |
|---|---|---|---|---|---|
| T1 | Credential theft | external attacker / malicious insider | DB dump, API leak, logs | envelope encryption with KEK outside DB, never returned by API, redaction in logs, `credentials:manage` scoped | KEK compromise → rotate KEK, re-wrap DEKs |
| T2 | Session hijack / CSRF | attacker with victim browser | cross-site POST, XSS | SameSite+HttpOnly cookies, Origin check, CSP without remote scripts, markdown renderer escapes HTML | inline styles allowed by CSP |
| T3 | Cross-tenant access | authenticated user | IDOR on ids | every query joins on org/workspace after membership check; RLS as defence in depth; tests for scope | RLS not active with owner role (documented) |
| T4 | Unauthorised terminal takeover | other user / admin | subscribing to another user's stream, sending input | input restricted to owner; observers need `sessions:read_all`; every attach audited | admins can observe (by design, audited) |
| T5 | Agent executes destructive command | model, prompt injection via logs/files | tool call with `rm -rf /` etc. | tool registry, shell AST policy, hard-block categories, approval by default, production ABAC, separate exec channel, output caps | novel obfuscation; humans can still approve R4 (audited, rollback hint shown) |
| T6 | Indirect prompt injection | attacker controlling host output | instructions embedded in log lines | untrusted-data framing, no tool can escalate privileges/mode, approvals are human | model may still be persuaded to *propose* bad commands → policy + approval |
| T7 | SSRF via custom provider/MCP URL | tenant admin/user | base URL pointing at metadata/internal services | `assertSafeUrl` (scheme, DNS-resolved private ranges, metadata hosts, redirects), HTTPS in production, allowlist opt-in | DNS rebinding between check and fetch: mitigated by re-validating each hop; pinning IP would need a custom agent |
| T8 | MITM on SSH | network attacker | host key substitution | strict host keys, mismatch refusal + R4 alert, TOFU explicit per host | TOFU hosts trust first key |
| T9 | Audit tampering | admin / attacker with DB access | UPDATE/DELETE rows | DB triggers, hash chain, external export (CSV/SIEM planned) | superuser can drop triggers → ship logs externally |
| T10 | Malicious skill/MCP/plugin | supply chain | install package that reads secrets | manifests validated (no shells/metachars, secret refs only, UI plugins can't touch secrets); runtimes not enabled | until sandboxes exist, only signed first-party extensions should be installed |
| T11 | DoS on gateway | tenant | many sessions / flood input | per-user & per-node caps, message size limits, rate limits, back-pressure pausing SSH streams, idle & max duration | in-memory limits per node |
| T12 | Secret leakage to external LLM | user / agent | context contains tokens | redaction of terminal tail, tool outputs and memories before send; memory API refuses secret-like content | regex coverage is heuristic |
| T13 | Brute force login | attacker | credential stuffing | per-IP rate limit, account lockout, scrypt | no MFA yet |
| T14 | Privilege escalation via mode | developer | switching to Auto mode | `agent:auto` permission required on create and patch; R4 never auto; auto only outside production | – |

Review cadence: update on every new tool, provider adapter, or extension runtime.
