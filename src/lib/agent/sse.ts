import { sseFrame, type ServerMessage } from "@/lib/protocol/messages";

/**
 * Runs an agent task while streaming protocol messages to the caller as SSE.
 */
export function agentStream(req: Request, task: (emit: (m: ServerMessage) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (m: ServerMessage) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(m)));
        } catch {
          closed = true;
        }
      };
      const done = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      task(emit, req.signal)
        .catch((err) => {
          emit({ v: 1, id: `err-${Date.now()}`, ts: Date.now(), sessionId: "00000000-0000-0000-0000-000000000000", type: "agent.status", runId: "", status: "failed", error: err instanceof Error ? err.message : "failed" });
        })
        .finally(done);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
