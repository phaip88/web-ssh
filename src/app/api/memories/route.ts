import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { memories } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { redactSecrets } from "@/lib/security/redact";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

const schema = z.object({ workspaceId: z.string().uuid().optional(), scope: z.enum(["user", "host", "workspace"]).default("user"), scopeRef: z.string().uuid().optional(), content: z.string().min(1).max(4000) });

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "agent:use");
  const rows = await db.select().from(memories).where(and(eq(memories.orgId, scope.orgId), eq(memories.userId, ctx.user.id), isNull(memories.deletedAt))).orderBy(desc(memories.createdAt)).limit(200);
  return json(rows);
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, schema);
  const scope = await resolveWorkspace(ctx, body.workspaceId);
  authorize(ctx, scope, "agent:use");
  const { text, findings } = redactSecrets(body.content);
  if (findings.length) throw new ApiError("VALIDATION_ERROR", `Memory contains secret-like content (${findings.join(", ")}); refusing to store`);
  const [row] = await db.insert(memories).values({ orgId: scope.orgId, workspaceId: scope.workspaceId, userId: ctx.user.id, scope: body.scope, scopeRef: body.scopeRef ?? null, content: text, source: "user" }).returning();
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "memory", resourceId: row.id, action: "memory.created", result: "success" });
  return json(row, { status: 201 });
});

export const DELETE = handler(async (req) => {
  const ctx = await requireAuth(req);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new ApiError("VALIDATION_ERROR", "id is required");
  const [row] = await db.update(memories).set({ deletedAt: new Date() }).where(and(eq(memories.id, id), eq(memories.userId, ctx.user.id))).returning({ id: memories.id, orgId: memories.orgId });
  if (!row) throw new ApiError("NOT_FOUND", "Memory not found");
  await audit({ actor: ctx, tenantId: row.orgId, resourceType: "memory", resourceId: row.id, action: "memory.deleted", result: "success" });
  return json({ ok: true });
});
