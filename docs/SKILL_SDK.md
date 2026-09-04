# Skill SDK (manifest v1)

A Skill is a versioned, signed capability package. **Current status:** manifests
are validated (`src/lib/extensions/manifests.ts`) and registries are modelled
(`skills`, `skill_versions`, `skill_installations`); the sandboxed runtime is
not yet shipped, so skills cannot execute. Examples live in `skills/`.

## manifest.yaml
| field | rules |
|---|---|
| `id` | reverse-DNS (`io.webssh.linux-system-inspector`) |
| `version` | semver; installations pin exact versions |
| `entrypoint` | relative path, no `..` |
| `compatibleRuntime` | e.g. `python-3.12-sandbox` |
| `permissions` | subset of `terminal:execute, terminal:read, filesystem:read, filesystem:write, process:list, service:status, container:list, kubernetes:get, logs:search, network:egress, artifact:create` |
| `tools[]` | `name, description, inputSchema (JSON Schema), risk R0–R4, requiresApproval` – **R4 tools must require approval** |
| `networkPolicy` | `egress: none|allowlist|any` – anything but `none` requires `network:egress` |
| `filesystemPolicy` | `readOnly` (default) – writable requires `filesystem:write` |
| `checksum` / `signature` | `sha256:<hex>` of the manifest; signature verified against the tenant's trusted keys before `approved` |

## Lifecycle (designed)
upload / git / https / registry → checksum + signature verification → permission preview → admin approval (`skills.status=approved`) → workspace enable (`skill_installations.enabled`) → per-user config → every tool call passes the same Policy Engine and approval flow as built-in tools → logs + audit (`skill.*` actions).

## Runtime contract (to implement)
- Runs in a container/worker with the manifest's CPU/memory/pids limits, no host env inheritance, only declared secrets injected.
- Receives tool invocations as JSON on stdin, returns JSON on stdout; host access only through the platform tool API (never raw SSH).
