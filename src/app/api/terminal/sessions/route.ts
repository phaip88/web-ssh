import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sshHosts, terminalSessions } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { buildConnectConfig } from "@/lib/ssh/connect";
import { countUserSessions, markSessionActive, openSession, registry } from "@/lib/ssh/registry";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

const createSchema = z.object({ hostId: z.string().uuid(), cols: z.number().int().min(2).max(500).default(80), rows: z.number().int().min(1).max(300).default(24) });

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "hosts:read");
  const all = new URL(req.url).searchParams.get("all") === "true";
  const where = all ? eq(terminalSessions.workspaceId, scope.workspaceId) : and(eq(terminalSessions.workspaceId, scope.workspaceId), eq(terminalSessions.userId, ctx.user.id));
  if (all) authorize(ctx, scope, "sessions:read_all");
  const rows = await db
    .select({ id: terminalSessions.id, hostId: terminalSessions.hostId, hostName: sshHosts.name, environment: sshHosts.environment, userId: terminalSessions.userId, title: terminalSessions.title, status: terminalSessions.status, closeReason: terminalSessions.closeReason, startedAt: terminalSessions.startedAt, endedAt: terminalSessions.endedAt, bytesIn: terminalSessions.bytesIn, bytesOut: terminalSessions.bytesOut, nodeId: terminalSessions.nodeId })
    .from(terminalSessions)
    .innerJoin(sshHosts, eq(sshHosts.id, terminalSessions.hostId))
    .where(where)
    .orderBy(desc(terminalSessions.startedAt))
    .limit(100);
  return json(rows.map((r) => ({ ...r, live: registry.has(r.id) })));
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, createSchema);
  const [host] = await db.select().from(sshHosts).where(and(eq(sshHosts.id, body.hostId), isNull(sshHosts.deletedAt))).limit(1);
  if (!host) throw new ApiError("NOT_FOUND", "Host not found");
  const scope = await resolveWorkspace(ctx, host.workspaceId);
  authorize(ctx, scope, "hosts:connect", { environment: host.environment });
  authorize(ctx, scope, "credentials:use", { environment: host.environment });
  if (countUserSessions(ctx.user.id) >= config.maxSessionsPerUser()) throw new ApiError("RATE_LIMITED", "Per-user session limit reached");

  const [row] = await db.insert(terminalSessions).values({ orgId: scope.orgId, workspaceId: scope.workspaceId, hostId: host.id, userId: ctx.user.id, title: host.name, cols: body.cols, rows: body.rows, nodeId: config.nodeId() }).returning();
  const { config: connect, outcome, cleanup } = await buildConnectConfig(host, ctx.user.id);
  const started = Date.now();
  try {
    await openSession({ sessionId: row.id, orgId: scope.orgId, workspaceId: scope.workspaceId, hostId: host.id, userId: ctx.user.id, environment: host.environment, connect, cols: body.cols, rows: body.rows, maxSessionDuration: host.maxSessionDuration, recordingEnabled: row.recordingEnabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : "SSH connection failed";
    const hk = outcome.current;
    const code = hk?.status === "unknown" ? "HOST_KEY_UNKNOWN" : hk?.status === "mismatch" ? "HOST_KEY_MISMATCH" : "SSH_ERROR";
    await db.update(terminalSessions).set({ status: "failed", closeReason: code === "SSH_ERROR" ? message : code, endedAt: new Date() }).where(eq(terminalSessions.id, row.id));
    await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "terminal_session", resourceId: row.id, action: "terminal.session.failed", result: "failure", riskLevel: code === "HOST_KEY_MISMATCH" ? "R4" : "R1", sessionId: row.id, metadata: { hostId: host.id, code, message, fingerprint: hk?.fingerprint } });
    throw new ApiError(code, code === "HOST_KEY_UNKNOWN" ? "Unknown host key – approve the fingerprint to continue" : code === "HOST_KEY_MISMATCH" ? "Host key changed! Connection refused." : `SSH connection failed: ${message}`, hk ? { fingerprint: hk.fingerprint, keyType: hk.keyType } : undefined);
  } finally {
    cleanup();
  }
  const latency = Date.now() - started;
  await markSessionActive(row.id);
  await db.update(sshHosts).set({ lastConnectedAt: new Date(), lastLatencyMs: latency }).where(eq(sshHosts.id, host.id));
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "terminal_session", resourceId: row.id, action: "terminal.session.opened", result: "success", riskLevel: host.environment === "production" ? "R2" : "R1", sessionId: row.id, metadata: { hostId: host.id, host: `${host.username}@${host.host}:${host.port}`, environment: host.environment, connectMs: latency, fingerprint: outcome.current?.fingerprint } });
  return json({ id: row.id, hostId: host.id, hostName: host.name, environment: host.environment, connectMs: latency }, { status: 201 });
});
