# Plugin SDK (v1 draft)

Plugin types: `ui`, `integration`, `agent_tool`, `auth`, `notification`, `secret`, `llm`.
**Status:** manifest schema + registry tables exist; the plugin host is not implemented.

## Manifest
```json
{ "id": "io.webssh.slack-notify", "name": "Slack notifications", "version": "1.0.0", "type": "notification",
  "sdkVersion": "^1.0.0", "capabilities": ["notify"], "permissions": ["notifications:send"],
  "checksum": "sha256:<hex>", "signature": "<base64>", "entry": "dist/index.js", "quota": { "callsPerMinute": 60 } }
```
Invariants enforced by the schema: semver versions, SDK compatibility range, checksum + signature required, no path traversal in `entry`, **UI plugins cannot request credential/provider/secret permissions**.

## Host contract (planned)
- Backend plugins run in isolated workers with call quotas and crash isolation; a crashing plugin is disabled and audited.
- UI plugins receive a scoped API client (same permissions as the user, minus secrets) and render inside a sandboxed iframe with a strict CSP.
- LLM provider plugins implement `ProviderAdapter` (`src/lib/llm/types.ts`).
- Upgrades keep the previous version installed for rollback.
