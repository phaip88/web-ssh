/**
 * Server -> browser stream for a terminal session (SSE). Clients reconnect
 * with ?since=<seq> to resume from the ring buffer; the first frame tells them
 * whether the resume was possible.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { terminalSessions } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { ApiError, errorResponse, requireAuth } from "@/lib/http";
import { envelope, sseFrame } from "@/lib/protocol/messages";
import { getLive, subscribe, unsubscribe } from "@/lib/ssh/registry";
import { resolveWorkspace } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAuth(req);
    const { id } = await params;
    const [row] = await db.select().from(terminalSessions).where(eq(terminalSessions.id, id)).limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Session not found");
    const scope = await resolveWorkspace(ctx, row.workspaceId);
    const observer = row.userId !== ctx.user.id;
    authorize(ctx, scope, observer ? "sessions:read_all" : "hosts:connect");
    const live = getLive(id);
    const since = new URL(req.url).searchParams.get("since");
    const encoder = new TextEncoder();
    const subId = crypto.randomUUID();
    let heartbeat: NodeJS.Timeout | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(frame));
            return (controller.desiredSize ?? 1) > 0;
          } catch {
            return false;
          }
        };
        if (!live) {
          write(sseFrame(envelope(id, "session.status", { status: row.status, resumable: false, lastSeq: 0, detail: { reason: row.closeReason } })));
          write(sseFrame(envelope(id, "terminal.closed", { reason: row.closeReason ?? "session is not live on this node" })));
          controller.close();
          return;
        }
        subscribe(live, { id: subId, write, close: () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }, pending: 0 }, since ? Number(since) : null);
        heartbeat = setInterval(() => write(sseFrame(envelope(id, "terminal.heartbeat", {}))), 15_000);
        req.signal.addEventListener("abort", () => {
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe(live, subId);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (live) unsubscribe(live, subId);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  } catch (err) {
    return errorResponse(err);
  }
}
