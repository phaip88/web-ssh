import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { credentials } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto/envelope";
import { handler, json, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

const schema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    name: z.string().min(1).max(120),
    type: z.enum(["password", "private_key"]),
    password: z.string().max(1024).optional(),
    privateKey: z.string().max(32 * 1024).optional(),
    passphrase: z.string().max(1024).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .refine((v) => (v.type === "password" ? !!v.password : !!v.privateKey), { message: "Secret material is required for the selected type" });

const publicShape = { id: credentials.id, name: credentials.name, type: credentials.type, fingerprint: credentials.fingerprint, expiresAt: credentials.expiresAt, revokedAt: credentials.revokedAt, lastUsedAt: credentials.lastUsedAt, createdAt: credentials.createdAt };

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "credentials:use");
  // Never select encrypted_secret here – it is only read by the SSH connector.
  const rows = await db.select(publicShape).from(credentials).where(and(eq(credentials.workspaceId, scope.workspaceId), isNull(credentials.deletedAt))).orderBy(desc(credentials.createdAt));
  return json(rows);
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, schema, 64 * 1024);
  const scope = await resolveWorkspace(ctx, body.workspaceId);
  authorize(ctx, scope, "credentials:manage");
  const id = crypto.randomUUID();
  const payload = body.type === "password" ? { password: body.password } : { privateKey: body.privateKey, passphrase: body.passphrase };
  const fingerprint = body.type === "private_key" ? `sha256:${createHash("sha256").update(body.privateKey ?? "").digest("hex").slice(0, 16)}` : null;
  const [row] = await db
    .insert(credentials)
    .values({ id, orgId: scope.orgId, workspaceId: scope.workspaceId, name: body.name, type: body.type, encryptedSecret: encryptSecret(JSON.stringify(payload), `credential:${id}`), fingerprint, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, createdBy: ctx.user.id })
    .returning(publicShape);
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "credential", resourceId: row.id, action: "credential.created", result: "success", riskLevel: "R2", metadata: { name: row.name, type: row.type } });
  return json(row, { status: 201 });
});
