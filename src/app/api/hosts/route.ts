import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { credentials, sshHosts } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";
import { hostSchema } from "@/lib/schemas/host";


export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "hosts:read");
  const rows = await db
    .select()
    .from(sshHosts)
    .where(and(eq(sshHosts.workspaceId, scope.workspaceId), isNull(sshHosts.deletedAt)))
    .orderBy(desc(sshHosts.isFavorite), sshHosts.name);
  return json(rows);
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, hostSchema);
  const scope = await resolveWorkspace(ctx, body.workspaceId);
  authorize(ctx, scope, "hosts:manage", { environment: body.environment });
  if (body.credentialId) {
    const [cred] = await db.select({ id: credentials.id }).from(credentials).where(and(eq(credentials.id, body.credentialId), eq(credentials.workspaceId, scope.workspaceId), isNull(credentials.deletedAt))).limit(1);
    if (!cred) throw new ApiError("VALIDATION_ERROR", "Credential does not belong to this workspace");
  }
  const { workspaceId: _w, ...rest } = body;
  const [row] = await db.insert(sshHosts).values({ ...rest, orgId: scope.orgId, workspaceId: scope.workspaceId, createdBy: ctx.user.id }).returning();
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "ssh_host", resourceId: row.id, action: "host.created", result: "success", metadata: { name: row.name, host: row.host, environment: row.environment } });
  return json(row, { status: 201 });
});
