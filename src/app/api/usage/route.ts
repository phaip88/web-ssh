import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { handler, json, requireAuth } from "@/lib/http";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "agent:use");
  const since = new Date(Date.now() - 30 * 86400_000);
  const byModel = await db
    .select({ model: usageRecords.model, requests: sql<number>`count(*)::int`, inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}),0)::int`, outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}),0)::int`, avgLatencyMs: sql<number>`coalesce(avg(${usageRecords.latencyMs}),0)::int`, failures: sql<number>`sum(case when ${usageRecords.success} then 0 else 1 end)::int` })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, scope.orgId), gte(usageRecords.createdAt, since)))
    .groupBy(usageRecords.model)
    .orderBy(desc(sql`count(*)`));
  const byDay = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt}), 'YYYY-MM-DD')`, inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}),0)::int`, outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}),0)::int`, requests: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, scope.orgId), gte(usageRecords.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${usageRecords.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageRecords.createdAt})`);
  return json({ byModel, byDay });
});
