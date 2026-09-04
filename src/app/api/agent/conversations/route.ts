import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentConversations } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { handler, json, parseBody, requireAuth } from "@/lib/http";
import { getLive } from "@/lib/ssh/registry";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";
import { ApiError } from "@/lib/http";

const createSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  terminalSessionId: z.string().uuid().optional(),
  hostId: z.string().uuid().optional(),
  mode: z.enum(["ask", "suggest", "approval", "auto", "plan"]).default("suggest"),
  providerId: z.string().uuid().optional(),
  model: z.string().max(120).optional(),
  title: z.string().max(200).optional(),
});

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "agent:use");
  const rows = await db.select().from(agentConversations).where(and(eq(agentConversations.workspaceId, scope.workspaceId), eq(agentConversations.userId, ctx.user.id), isNull(agentConversations.deletedAt))).orderBy(desc(agentConversations.updatedAt)).limit(50);
  return json(rows);
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, createSchema);
  const scope = await resolveWorkspace(ctx, body.workspaceId);
  authorize(ctx, scope, "agent:use");
  if (body.mode === "auto") authorize(ctx, scope, "agent:auto");
  let hostId = body.hostId ?? null;
  if (body.terminalSessionId) {
    const live = getLive(body.terminalSessionId);
    if (!live || live.userId !== ctx.user.id) throw new ApiError("NOT_FOUND", "Terminal session is not live or not yours");
    hostId = live.hostId;
  }
  const [row] = await db.insert(agentConversations).values({ orgId: scope.orgId, workspaceId: scope.workspaceId, userId: ctx.user.id, terminalSessionId: body.terminalSessionId ?? null, hostId, mode: body.mode, providerId: body.providerId ?? null, model: body.model ?? null, title: body.title ?? null }).returning();
  return json(row, { status: 201 });
});
