import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { organizations, workspaces } from "@/db/schema";
import { permissionsFor } from "@/lib/auth/rbac";
import { handler, json, requireAuth } from "@/lib/http";
import { appEnv } from "@/lib/config";

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const orgIds = ctx.memberships.map((m) => m.orgId);
  const wsIds = ctx.memberships.flatMap((m) => m.workspaces.map((w) => w.workspaceId));
  const orgs = orgIds.length ? await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
  const wss = wsIds.length ? await db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, orgId: workspaces.orgId }).from(workspaces).where(inArray(workspaces.id, wsIds)) : [];
  return json({
    user: ctx.user,
    env: appEnv(),
    organizations: orgs,
    workspaces: wss.map((w) => ({ ...w, role: ctx.memberships.find((m) => m.orgId === w.orgId)?.workspaces.find((x) => x.workspaceId === w.id)?.role ?? null, permissions: [...permissionsFor(ctx, { orgId: w.orgId, workspaceId: w.id })] })),
  });
});
