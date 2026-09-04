import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentConversations } from "@/db/schema";
import { startRun } from "@/lib/agent/runtime";
import { agentStream } from "@/lib/agent/sse";
import { authorize } from "@/lib/auth/rbac";
import { ApiError, errorResponse, parseBody, rateLimit, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
const schema = z.object({ content: z.string().min(1).max(16_000) });

/** Sends a user message and streams the agent run (deltas, tool requests, approvals) back as SSE. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth(req);
    const { id } = await params;
    rateLimit(`agent:${ctx.user.id}`, 30, 60_000);
    const { content } = await parseBody(req, schema);
    const [c] = await db.select().from(agentConversations).where(and(eq(agentConversations.id, id), eq(agentConversations.userId, ctx.user.id))).limit(1);
    if (!c) throw new ApiError("NOT_FOUND", "Conversation not found");
    const scope = await resolveWorkspace(ctx, c.workspaceId);
    authorize(ctx, scope, "agent:use");
    return agentStream(req, async (emit, signal) => {
      await startRun(ctx, id, content, emit, signal);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
