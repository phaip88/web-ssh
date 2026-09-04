import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sshHostKeys, sshHosts } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";
import { hostPatchSchema } from "@/lib/schemas/host";

async function loadHost(id: string) {
  const [host] = await db.select().from(sshHosts).where(and(eq(sshHosts.id, id), isNull(sshHosts.deletedAt))).limit(1);
  if (!host) throw new ApiError("NOT_FOUND", "Host not found");
  return host;
}

export const GET = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const host = await loadHost(id);
  const scope = await resolveWorkspace(ctx, host.workspaceId);
  authorize(ctx, scope, "hosts:read");
  const keys = await db.select().from(sshHostKeys).where(eq(sshHostKeys.hostId, host.id));
  return json({ ...host, hostKeys: keys.map((k) => ({ id: k.id, keyType: k.keyType, fingerprintSha256: k.fingerprintSha256, status: k.status, approvedAt: k.approvedAt, createdAt: k.createdAt })) });
});

export const PATCH = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const host = await loadHost(id);
  const scope = await resolveWorkspace(ctx, host.workspaceId);
  const body = await parseBody(req, hostPatchSchema);
  authorize(ctx, scope, "hosts:manage", { environment: body.environment ?? host.environment });
  const { workspaceId: _w, version, ...rest } = body;
  const [row] = await db
    .update(sshHosts)
    .set({ ...rest, version: host.version + 1, updatedAt: new Date() })
    .where(and(eq(sshHosts.id, host.id), eq(sshHosts.version, version ?? host.version)))
    .returning();
  if (!row) throw new ApiError("CONFLICT", "Host was modified concurrently; reload and retry");
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "ssh_host", resourceId: row.id, action: "host.updated", result: "success", metadata: { changed: Object.keys(rest) } });
  return json(row);
});

export const DELETE = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const host = await loadHost(id);
  const scope = await resolveWorkspace(ctx, host.workspaceId);
  authorize(ctx, scope, "hosts:manage", { environment: host.environment });
  await db.update(sshHosts).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(sshHosts.id, host.id));
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "ssh_host", resourceId: host.id, action: "host.deleted", result: "success", riskLevel: "R2" });
  return json({ ok: true });
});
