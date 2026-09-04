# Runbook: troubleshooting, backup & restore, production checklist

## Troubleshooting

| symptom | check | fix |
|---|---|---|
| `Refusing to start in production without: APP_MASTER_KEY` | env | set a 32-byte base64 key; never reuse dev key |
| Login returns 403 `CSRF_REJECTED` | reverse proxy strips `Origin`/`Host` | forward `Host`/`X-Forwarded-Host`; add public origin to `ALLOWED_ORIGINS` |
| Terminal opens then shows nothing / stalls | proxy buffering SSE | disable buffering (Caddyfile `flush_interval -1`, nginx `proxy-buffering: off`) |
| `HOST_KEY_UNKNOWN` (428) | strict policy, first connection | verify fingerprint out-of-band, click *Trust fingerprint* (needs `hosts:manage`) |
| `HOST_KEY_MISMATCH` (409) + R4 audit | key rotated or MITM | confirm with host owner, revoke old key on host page, reconnect to record the new one |
| `SSH_ERROR: All configured authentication methods failed` | credential | rotate credential, check username/auth type |
| Agent: `No enabled model provider is configured` | providers | add provider (Providers page) or run seed for the mock provider |
| Agent: `circuit open` | provider failures | wait 60 s or fix upstream; check `usage_records.success` |
| `Per-user session limit reached` | `MAX_SESSIONS_PER_USER` | close idle sessions (Sessions page) |
| Audit `verify` reports broken chain | tampering or manual DB edits | investigate immediately; triggers should have prevented it – check who dropped them |
| Recording events missing | `[recording] flush failed` in logs | DB connectivity; events are buffered 1 s and flushed on close |

Useful queries:
```sql
select status, count(*) from terminal_sessions group by 1;
select action, result, count(*) from audit_events where timestamp > now() - interval '1 day' group by 1,2 order by 3 desc;
select * from approvals where status='pending' and expires_at < now();  -- stale approvals
```

## Backup & restore

Backup (daily, retain 30):
```bash
pg_dump "$DATABASE_URL" --format=custom --file=backup/webssh-$(date +%F).dump
# the KEK is NOT in the database – back up APP_MASTER_KEY separately (KMS/Vault/sealed secret); without it credentials are unrecoverable by design
```
Restore drill (quarterly):
```bash
createdb app_restore && pg_restore --dbname=app_restore backup/webssh-YYYY-MM-DD.dump
psql app_restore -f drizzle/sql/audit_guard.sql          # triggers/policies are part of the dump but re-apply to be safe
DATABASE_URL=postgresql://.../app_restore npm run build && npm start   # smoke: login, open a session, verify audit chain
```
Recovery objectives: RPO 24 h (daily dump; enable WAL archiving for minutes), RTO < 1 h single node.

## Production go-live checklist
- [ ] `APP_ENV=production`, unique `APP_MASTER_KEY` stored in KMS/Vault, not in git
- [ ] Seed accounts removed or passwords rotated; `NEXT_PUBLIC_SHOW_DEMO_HINT=false`
- [ ] `MOCK_SSH_ENABLED=false`, `PROVIDER_ALLOW_HTTP=false`, `PROVIDER_ALLOW_PRIVATE_HOSTS` only if needed
- [ ] TLS terminated (Caddy/Ingress), HSTS active, `ALLOWED_ORIGINS` set
- [ ] Database: dedicated role, backups scheduled, restore drill done, `audit_guard.sql` applied
- [ ] Image pinned by digest, Trivy clean of HIGH/CRITICAL, cosign signature verified
- [ ] NetworkPolicy restricts SSH egress to managed CIDRs and blocks metadata IPs
- [ ] Roles reviewed: who has `env:production`, `agent:auto`, `approvals:decide`, `audit:read`
- [ ] Alerting on `ssh.hostkey.mismatch`, `agent.tool.requested` with `decision=blocked`, failed logins spike, audit chain verification job
- [ ] Multi-node: cookie affinity enabled; Redis planned for shared limits
- [ ] Break-glass procedure documented (platform admin + out-of-band approval; all actions audited)
