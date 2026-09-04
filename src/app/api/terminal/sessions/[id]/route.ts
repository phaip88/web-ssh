import { eq } from "drizzle-orm";
import { db } from "@/db";
import { terminalEvents, terminalSessions } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, requireAuth } from "@/lib/http";
import { closeSession, getLive } from "@/lib/ssh/registry";
import { resolveWorkspace } from "@/lib/tenancy";

/** Session metadata + recorded events (for replay). */
export const GET = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const [row] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Session not found");
  const scope = await resolveWorkspace(ctx, row.workspaceId);
  authorize(ctx, scope, row.userId === ctx.user.id ? "hosts:read" : "recordings:read");
  const events = await db.select({ seq: terminalEvents.seq, kind: terminalEvents.kind, offsetMs: terminalEvents.offsetMs, data: terminalEvents.data, redacted: terminalEvents.redacted }).from(terminalEvents).where(eq(terminalEvents.sessionId, id)).orderBy(terminalEvents.id).limit(20_000);
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "terminal_recording", resourceId: id, action: "recording.viewed", result: "success", riskLevel: "R1", sessionId: id, metadata: { events: events.length, owner: row.userId === ctx.user.id } });
  return json({ session: { ...row, live: !!getLive(id) }, events });
});

export const DELETE = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const [row] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Session not found");
  const scope = await resolveWorkspace(ctx, row.workspaceId);
  if (row.userId !== ctx.user.id) authorize(ctx, scope, "sessions:read_all");
  await closeSession(id, `closed by ${row.userId === ctx.user.id ? "owner" : "administrator"}`);
  if (!getLive(id) && row.status !== "closed") await db.update(terminalSessions).set({ status: "closed", closeReason: "closed by user", endedAt: new Date() }).where(eq(terminalSessions.id, id));
  return json({ ok: true });
});
