import { and, desc, eq, gte, ilike, lte, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { verifyChain } from "@/lib/audit";
import { handler, json, requireAuth } from "@/lib/http";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "audit:read");
  const q = new URL(req.url).searchParams;
  const conds: SQL[] = [eq(auditEvents.tenantId, scope.orgId)];
  if (q.get("action")) conds.push(ilike(auditEvents.action, `%${q.get("action")}%`));
  if (q.get("result")) conds.push(eq(auditEvents.result, q.get("result")!));
  if (q.get("riskLevel")) conds.push(eq(auditEvents.riskLevel, q.get("riskLevel")!));
  if (q.get("resourceType")) conds.push(eq(auditEvents.resourceType, q.get("resourceType")!));
  if (q.get("from")) conds.push(gte(auditEvents.timestamp, new Date(q.get("from")!)));
  if (q.get("to")) conds.push(lte(auditEvents.timestamp, new Date(q.get("to")!)));
  const limit = Math.min(500, Number(q.get("limit") ?? 100));
  const rows = await db.select().from(auditEvents).where(and(...conds)).orderBy(desc(auditEvents.seq)).limit(limit);
  const verify = q.get("verify") === "true" ? await verifyChain(scope.orgId, 5000) : null;
  if (q.get("format") === "csv") {
    const header = "seq,eventId,timestamp,actorId,action,resourceType,resourceId,result,riskLevel,sourceIp,integrityHash\n";
    const body = rows.map((r) => [r.seq, r.eventId, r.timestamp.toISOString(), r.actorId, r.action, r.resourceType, r.resourceId, r.result, r.riskLevel, r.sourceIp, r.integrityHash].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    return new Response(header + body, { headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=audit.csv" } });
  }
  return json({ events: rows, verify });
});
