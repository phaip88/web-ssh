import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentConversations, agentMessages, agentToolCalls, approvals } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";

const patchSchema = z.object({ mode: z.enum(["ask", "suggest", "approval", "auto", "plan"]).optional(), providerId: z.string().uuid().nullable().optional(), model: z.string().max(120).nullable().optional(), title: z.string().max(200).optional() });

async function load(id: string, userId: string) {
  const [c] = await db.select().from(agentConversations).where(and(eq(agentConversations.id, id), eq(agentConversations.userId, userId))).limit(1);
  if (!c) throw new ApiError("NOT_FOUND", "Conversation not found");
  return c;
}

export const GET = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const c = await load(id, ctx.user.id);
  const messages = await db.select().from(agentMessages).where(eq(agentMessages.conversationId, id)).orderBy(agentMessages.createdAt).limit(500);
  const toolCalls = await db.select().from(agentToolCalls).where(eq(agentToolCalls.conversationId, id)).orderBy(agentToolCalls.createdAt).limit(200);
  const pending = await db.select().from(approvals).where(and(eq(approvals.requestedBy, ctx.user.id), eq(approvals.status, "pending"))).limit(20);
  return json({ conversation: c, messages, toolCalls, pendingApprovals: pending.filter((p) => (p.details as { conversationId?: string }).conversationId === id) });
});

export const PATCH = handler(async (req, { params }) => {
  const ctx = await requireAuth(req);
  const { id } = await params;
  const c = await load(id, ctx.user.id);
  const scope = await resolveWorkspace(ctx, c.workspaceId);
  const body = await parseBody(req, patchSchema);
  if (body.mode === "auto") authorize(ctx, scope, "agent:auto");
  const [row] = await db.update(agentConversations).set({ ...body, updatedAt: new Date() }).where(eq(agentConversations.id, id)).returning();
  return json(row);
});
