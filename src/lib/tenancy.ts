import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { ApiError } from "@/lib/http";

export interface WorkspaceScope {
  orgId: string;
  workspaceId: string;
}

/**
 * Resolves the workspace a request operates on and verifies the caller is a
 * member (or platform admin). Every tenant-scoped query must use this scope.
 */
export async function resolveWorkspace(ctx: AuthContext, workspaceId?: string | null): Promise<WorkspaceScope> {
  if (workspaceId) {
    const [ws] = await db.select({ id: workspaces.id, orgId: workspaces.orgId }).from(workspaces).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt))).limit(1);
    if (!ws) throw new ApiError("NOT_FOUND", "Workspace not found");
    const member = ctx.user.isPlatformAdmin || ctx.memberships.some((m) => m.orgId === ws.orgId && (m.orgRole === "org_owner" || m.workspaces.some((w) => w.workspaceId === ws.id)));
    if (!member) throw new ApiError("FORBIDDEN", "Not a member of this workspace");
    return { orgId: ws.orgId, workspaceId: ws.id };
  }
  const first = ctx.memberships.find((m) => m.workspaces.length > 0);
  if (!first) throw new ApiError("FORBIDDEN", "User has no workspace membership");
  return { orgId: first.orgId, workspaceId: first.workspaces[0].workspaceId };
}

export function workspaceIdFrom(req: Request): string | null {
  return new URL(req.url).searchParams.get("workspaceId");
}
