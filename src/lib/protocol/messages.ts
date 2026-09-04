/**
 * Real-time protocol envelope shared by the SSE/HTTP transport used in this
 * deployment and the WebSocket transport described in docs/WEBSOCKET_PROTOCOL.md.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  ts: z.number().int(),
  sessionId: z.string().uuid(),
  type: z.string(),
});

export const terminalInputSchema = envelopeSchema.extend({
  type: z.literal("terminal.input"),
  data: z.string().max(64 * 1024),
});
export const terminalResizeSchema = envelopeSchema.extend({
  type: z.literal("terminal.resize"),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});
export const terminalSignalSchema = envelopeSchema.extend({
  type: z.literal("terminal.signal"),
  signal: z.enum(["INT", "TERM", "KILL", "HUP", "EOF"]),
});
export const terminalHeartbeatSchema = envelopeSchema.extend({ type: z.literal("terminal.heartbeat") });

export const clientMessageSchema = z.discriminatedUnion("type", [
  terminalInputSchema,
  terminalResizeSchema,
  terminalSignalSchema,
  terminalHeartbeatSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { v: 1; id: string; ts: number; sessionId: string; type: "terminal.output"; seq: number; data: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "terminal.error"; code: string; message: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "terminal.closed"; reason: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "terminal.heartbeat"; latencyMs?: number }
  | { v: 1; id: string; ts: number; sessionId: string; type: "session.status"; status: string; resumable: boolean; lastSeq: number; detail?: Record<string, unknown> }
  | { v: 1; id: string; ts: number; sessionId: string; type: "agent.delta"; runId: string; delta: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "agent.message"; runId: string; messageId: string; content: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "agent.tool.request"; runId: string; toolCallId: string; tool: string; input: unknown; risk: string; decision: string; findings: unknown[] }
  | { v: 1; id: string; ts: number; sessionId: string; type: "agent.tool.result"; runId: string; toolCallId: string; output: unknown; status: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "approval.required"; runId: string; approvalId: string; toolCallId: string; summary: string; details: Record<string, unknown>; risk: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "approval.result"; approvalId: string; status: string }
  | { v: 1; id: string; ts: number; sessionId: string; type: "agent.status"; runId: string; status: string; error?: string };

let counter = 0;
export function msgId(): string {
  counter = (counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function envelope<T extends ServerMessage["type"]>(
  sessionId: string,
  type: T,
  body: Omit<Extract<ServerMessage, { type: T }>, "v" | "id" | "ts" | "sessionId" | "type">,
): Extract<ServerMessage, { type: T }> {
  return { v: PROTOCOL_VERSION, id: msgId(), ts: Date.now(), sessionId, type, ...body } as Extract<ServerMessage, { type: T }>;
}

export function sseFrame(msg: ServerMessage): string {
  return `event: ${msg.type}\nid: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`;
}
