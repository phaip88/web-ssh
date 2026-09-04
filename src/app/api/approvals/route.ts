import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { handler, json, requireAuth } from "@/lib/http";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "agent:use");
  const status = new URL(req.url).searchParams.get("status");
  const rows = await db
    .select()
    .from(approvals)
    .where(status ? and(eq(approvals.workspaceId, scope.workspaceId), eq(approvals.status, status)) : eq(approvals.workspaceId, scope.workspaceId))
    .orderBy(desc(approvals.createdAt))
    .limit(100);
  return json(rows);
});
