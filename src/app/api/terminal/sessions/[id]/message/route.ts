/**
 * Browser -> server channel. Accepts one protocol message per request
 * (terminal.input / terminal.resize / terminal.signal / terminal.heartbeat).
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { terminalSessions } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { config } from "@/lib/config";
import { ApiError, handler, json, parseBody, rateLimit, requireAuth } from "@/lib/http";
import { clientMessageSchema } from "@/lib/protocol/messages";
import { getLive, resize, sendSignal, writeInput } from "@/lib/ssh/registry";
import { resolveWorkspace } from "@/lib/tenancy";

export const POST = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  rateLimit(`term:${ctx.user.id}`, 600, 10_000);
  const msg = await parseBody(req, clientMessageSchema, config.maxWsMessageBytes() + 1024);
  if (msg.sessionId !== id) throw new ApiError("VALIDATION_ERROR", "sessionId mismatch");
  const live = getLive(id);
  if (!live) throw new ApiError("NOT_FOUND", "Session is not live");
  if (live.userId !== ctx.user.id) throw new ApiError("FORBIDDEN", "Only the session owner may send input");
  const scope = await resolveWorkspace(ctx, live.workspaceId);
  authorize(ctx, scope, "terminal:execute", { environment: live.environment });
  switch (msg.type) {
    case "terminal.input":
      writeInput(live, msg.data);
      break;
    case "terminal.resize":
      resize(live, msg.cols, msg.rows);
      await db.update(terminalSessions).set({ cols: msg.cols, rows: msg.rows }).where(eq(terminalSessions.id, id));
      break;
    case "terminal.signal":
      sendSignal(live, msg.signal);
      break;
    case "terminal.heartbeat":
      live.lastActivity = Date.now();
      break;
  }
  return json({ ok: true, seq: live.seq });
});
