# Deployment

## 1. Single node (Docker Compose)

```bash
cp .env.example .env
# set at least: POSTGRES_PASSWORD, REDIS_PASSWORD, APP_MASTER_KEY=$(openssl rand -base64 32), PUBLIC_HOST=ssh.example.com, PUBLIC_URL=https://ssh.example.com
docker compose --profile prod up -d --build
docker compose --profile prod run --rm app node_modules/.bin/tsx scripts/seed.ts   # optional first admin (dev seed) – or create users via SQL/admin tooling
```

- Caddy terminates TLS (automatic Let's Encrypt for `PUBLIC_HOST`) and disables buffering for SSE.
- `migrate` runs `drizzle-kit push` before `app` starts; apply `drizzle/sql/audit_guard.sql` once (`psql -f`).
- Data volumes: `pgdata`, `redisdata`, `caddydata`. Backups: see `docs/RUNBOOK.md`.
- Logs: json-file driver with rotation (50 MB × 5).
- Healthcheck: `GET /api/health` (readiness, checks DB), `GET /api/health?probe=live`.

## 2. Kubernetes (Helm)

```bash
kubectl create ns webssh
kubectl -n webssh create secret generic webssh-agent-secrets \
  --from-literal=DATABASE_URL='postgresql://user:pass@postgres:5432/app_db' \
  --from-literal=APP_MASTER_KEY="$(openssl rand -base64 32)"
helm upgrade --install webssh deploy/helm/webssh-agent -n webssh \
  --set ingress.host=ssh.example.com --set env.ALLOWED_ORIGINS=https://ssh.example.com \
  --set image.digest=sha256:<pinned>
```

Chart provides: Deployment (rolling, non-root, read-only FS, seccomp RuntimeDefault, dropped caps, topology spread), Service, Ingress (SSE buffering off, cookie affinity), HPA, PDB, NetworkPolicy (DNS, Postgres, SSH CIDRs, 443 egress minus private/metadata ranges), pre-upgrade migration Job, ServiceAccount without token automount.

Rollback: `helm rollback webssh <rev>`. Schema changes are additive; for destructive migrations write an explicit down script and test on a restored backup first.

## 3. Configuration reference

All variables are listed in `.env.example`. Production must set explicitly:
`APP_ENV=production`, `APP_MASTER_KEY`, `DATABASE_URL`, `ALLOWED_ORIGINS`,
`MOCK_SSH_ENABLED=false`, `PROVIDER_ALLOW_HTTP=false`, `NEXT_PUBLIC_SHOW_DEMO_HINT=false`.
The process refuses to boot without the master key in production.

## 4. Key rotation
1. Generate a new KEK; deploy with `APP_MASTER_KEY_NEXT` (planned) or run a re-wrap job: decrypt DEKs with old KEK, wrap with new, bump `key_version`.
2. Rotate SSH credentials via the Credentials page (create new, rebind hosts, revoke old – revocation is immediate for new sessions).
3. Provider API keys: create a new provider record, mark default, delete the old one.

## 5. Multi-node notes
Sessions are bound to `NODE_ID`. Use cookie affinity (Ingress annotations in values.yaml) or an external gateway. Rate limits are per node until Redis-backed limits are wired (`REDIS_URL` reserved).
