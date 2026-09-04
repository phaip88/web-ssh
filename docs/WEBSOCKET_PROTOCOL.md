# Real-time protocol v1

All messages share the envelope below. The current transport is **SSE (server→client) + HTTP POST (client→server)**; a WebSocket transport carries the identical JSON frames (one message per text frame). Schemas live in `src/lib/protocol/messages.ts` (zod).

```json
{ "v": 1, "id": "<unique message id>", "ts": 1710000000000, "sessionId": "<uuid>", "type": "terminal.output", "...": "type specific" }
```

## Client → server (`POST /api/terminal/sessions/{id}/message`)
| type | fields | limits |
|---|---|---|
| `terminal.input` | `data: string` | ≤ `MAX_TERMINAL_MESSAGE_BYTES` (64 KiB), 600 msgs / 10 s per user |
| `terminal.resize` | `cols 2–500`, `rows 1–300` | |
| `terminal.signal` | `signal: INT|TERM|KILL|HUP|EOF` | |
| `terminal.heartbeat` | – | refreshes idle timer |
| `auth` | (WebSocket only) `token` – on SSE/HTTP the session cookie authenticates | |

## Server → client (`GET /api/terminal/sessions/{id}/stream[?since=seq]`, `event:` = type)
| type | fields | notes |
|---|---|---|
| `session.status` | `status, resumable, lastSeq, detail` | first frame; `resumable=false` means the ring buffer no longer holds `since` – client shows a "gap" notice |
| `terminal.output` | `seq, data(base64)` | monotonically increasing `seq`; clients drop `seq ≤ lastSeq` |
| `terminal.heartbeat` | – | every 15 s; client derives latency from `ts` |
| `terminal.error` | `code, message` | |
| `terminal.closed` | `reason` | terminal frame; stream ends |

## Agent stream (`POST /api/agent/conversations/{id}/messages`, `POST /api/approvals/{id}/decide`)
| type | fields |
|---|---|
| `agent.status` | `runId, status: thinking|waiting_approval|completed|failed|cancelled, error?` |
| `agent.delta` | `runId, delta` |
| `agent.message` | `runId, messageId, content` |
| `agent.tool.request` | `runId, toolCallId, tool, input, risk, decision, findings[]` |
| `agent.tool.result` | `runId, toolCallId, output, status: executed|failed|blocked|rejected` |
| `approval.required` | `runId, approvalId, toolCallId, summary, details{tool,input,command,environment,findings,user,rollback}, risk` |
| `approval.result` | `approvalId, status` |

## Back-pressure & limits
- Server pauses the SSH stream when any subscriber buffer exceeds 512 KiB and resumes after drain.
- Ring buffer keeps the last 256 KiB of output for resume; beyond that `resumable=false`.
- Idle timeout (`TERMINAL_IDLE_TIMEOUT_SECONDS`), max session duration per host, per-user/per-node caps.

## Error codes (HTTP body `{error:{code,message,details}}`)
`UNAUTHENTICATED 401 · FORBIDDEN 403 · CSRF_REJECTED 403 · POLICY_BLOCKED 403 · VALIDATION_ERROR 400 · NOT_FOUND 404 · CONFLICT 409 · HOST_KEY_MISMATCH 409 · PAYLOAD_TOO_LARGE 413 · HOST_KEY_UNKNOWN 428 · RATE_LIMITED 429 · INTERNAL 500 · SSH_ERROR 502 · PROVIDER_ERROR 502`
