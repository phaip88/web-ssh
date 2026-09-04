import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sshHostKeys, sshHosts } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";

const schema = z.object({ keyId: z.string().uuid().optional(), fingerprint: z.string().max(128).optional(), action: z.enum(["trust", "revoke"]) }).refine((v) => v.keyId || v.fingerprint, { message: "keyId or fingerprint required" });

/** First-connection fingerprint approval / revocation. */
export const POST = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const [host] = await db.select().from(sshHosts).where(eq(sshHosts.id, id)).limit(1);
  if (!host) throw new ApiError("NOT_FOUND", "Host not found");
  const scope = await resolveWorkspace(ctx, host.workspaceId);
  authorize(ctx, scope, "hosts:manage", { environment: host.environment });
  const { keyId, fingerprint, action } = await parseBody(req, schema);
  const [key] = await db.select().from(sshHostKeys).where(and(keyId ? eq(sshHostKeys.id, keyId) : eq(sshHostKeys.fingerprintSha256, fingerprint!), eq(sshHostKeys.hostId, host.id))).limit(1);
  if (!key) throw new ApiError("NOT_FOUND", "Host key not found");
  const status = action === "trust" ? "trusted" : "revoked";
  await db.update(sshHostKeys).set({ status, approvedBy: ctx.user.id, approvedAt: new Date(), updatedAt: new Date() }).where(eq(sshHostKeys.id, key.id));
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "ssh_host_key", resourceId: key.id, action: `ssh.hostkey.${status}`, result: "success", riskLevel: "R2", metadata: { hostId: host.id, fingerprint: key.fingerprintSha256 } });
  return json({ ok: true, status });
});
