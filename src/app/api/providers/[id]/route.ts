import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { modelProviders } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { ApiError, handler, json, requireAuth } from "@/lib/http";
import { resolveProvider } from "@/lib/llm/gateway";
import { resolveWorkspace } from "@/lib/tenancy";

async function load(id: string) {
  const [p] = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  if (!p || p.deletedAt) throw new ApiError("NOT_FOUND", "Provider not found");
  return p;
}

/** Health check / credential validation. */
export const POST = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const p = await load(id);
  const scope = await resolveWorkspace(ctx, null);
  if (scope.orgId !== p.orgId) throw new ApiError("NOT_FOUND", "Provider not found");
  authorize(ctx, scope, "agent:use");
  const { adapter } = await resolveProvider(p.orgId, ctx.user.id, p.id);
  const health = await adapter.healthCheck();
  let models: string[] = [];
  if (health.ok) models = await adapter.listModels().catch(() => []);
  return json({ ...health, models: models.slice(0, 50) });
});

export const DELETE = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const p = await load(id);
  const scope = await resolveWorkspace(ctx, null);
  if (scope.orgId !== p.orgId) throw new ApiError("NOT_FOUND", "Provider not found");
  if (p.ownerUserId !== ctx.user.id) authorize(ctx, scope, "providers:manage");
  await db.update(modelProviders).set({ deletedAt: new Date(), enabled: false }).where(and(eq(modelProviders.id, id), eq(modelProviders.orgId, scope.orgId)));
  await audit({ actor: ctx, tenantId: scope.orgId, resourceType: "model_provider", resourceId: id, action: "provider.deleted", result: "success", riskLevel: "R2" });
  return json({ ok: true });
});
