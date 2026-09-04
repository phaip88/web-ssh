import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals } from "@/db/schema";
import { applyApprovalDecision } from "@/lib/agent/runtime";
import { agentStream } from "@/lib/agent/sse";
import { authorize } from "@/lib/auth/rbac";
import { ApiError, errorResponse, parseBody, requireAuth } from "@/lib/http";
import { resolveWorkspace } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
const schema = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(500).optional() });

/** Human decision on a pending tool call. Streams the continued agent run back as SSE. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth(req);
    const { id } = await params;
    const body = await parseBody(req, schema);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    if (!a) throw new ApiError("NOT_FOUND", "Approval not found");
    const scope = await resolveWorkspace(ctx, a.workspaceId);
    authorize(ctx, scope, "approvals:decide");
    // The requesting user's agent run is resumed; a different approver is allowed
    // only when they hold approvals:decide in the same workspace (checked above).
    if (a.requestedBy !== ctx.user.id) authorize(ctx, scope, "sessions:read_all");
    return agentStream(req, async (emit, signal) => {
      await applyApprovalDecision(ctx, id, body.decision, body.note, emit, signal);
    });
  } catch (err) {
    return errorResponse(err);
  }
}
