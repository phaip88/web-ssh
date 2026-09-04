# MCP server management

**Status:** configuration schema (`mcpServerConfigSchema`) and tables
(`mcp_servers`, `mcp_tools`) are implemented; the client manager (start/stop,
tool discovery, invocation) is planned. The schema already enforces the
security invariants the manager will rely on.

## Configuration
```json
{ "name": "filesystem", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
  "envSecretRefs": { "API_TOKEN": "secret://<credential-id>" }, "timeout": 30000,
  "allowedTools": ["read_file", "list_directory"], "deniedTools": ["write_file"],
  "networkPolicy": { "egress": "none" }, "resourceLimits": { "cpu": "500m", "memory": "256Mi", "pids": 64 }, "autoStart": false }
```
Rules enforced now: `stdio` needs `command`; remote transports need `url` (validated by the SSRF guard on save); shell interpreters are rejected as commands; args may not contain `; & | \` $`; env/header values must be `secret://` references (no plaintext secrets); resource limits default to 500m/256Mi/64 pids.

## Planned runtime behaviour
- stdio servers run in a sandbox container without host env; only declared secrets injected.
- Discovered tools are stored in `mcp_tools` **disabled** with a default risk of R2; an admin enables each tool and sets risk.
- Every MCP tool call goes through the same registry → policy → approval → audit pipeline as built-in tools; sampling requests from servers require an explicit grant.
- Health checks and auto-reconnect with exponential backoff; request/response bodies shown in the UI with redaction.
