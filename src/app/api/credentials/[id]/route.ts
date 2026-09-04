import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { credentials } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";

export const DELETE = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const [cred] = await db.select({ id: credentials.id, workspaceId: credentials.workspaceId }).from(credentials).where(and(eq(credentials.id, id), isNull(credentials.deletedAt))).limit(1);
  if (!cred) throw new ApiError("NOT_FOUND", "Credential not found");
  const scope = await resolveWorkspace(ctx, cred.workspaceId);
  authorize(ctx, scope, "credentials:manage");
  const revoke = new URL(req.url).searchParams.get("mode") === "revoke";
  await db.update(credentials).set(revoke ? { revokedAt: new Date(), updatedAt: new Date() } : { deletedAt: new Date(), revokedAt: new Date(), updatedAt: new Date() }).where(eq(credentials.id, cred.id));
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "credential", resourceId: cred.id, action: revoke ? "credential.revoked" : "credential.deleted", result: "success", riskLevel: "R2" });
  return json({ ok: true });
});
