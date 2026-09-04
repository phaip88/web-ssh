"use client";

export class ClientApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
    public status?: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new ClientApiError(body.error?.code ?? "ERROR", body.error?.message ?? res.statusText, body.error?.details, res.status);
  }
  return body.data as T;
}

export interface SseMessage {
  v: number;
  id: string;
  ts: number;
  sessionId: string;
  type: string;
  [k: string]: unknown;
}

/**
 * Consumes an SSE response body produced by a POST (EventSource only supports GET).
 */
export async function consumeSse(res: Response, onMessage: (m: SseMessage) => void, signal?: AbortSignal): Promise<void> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    throw new ClientApiError(body.error?.code ?? "ERROR", body.error?.message ?? res.statusText, undefined, res.status);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        onMessage(JSON.parse(dataLine.slice(5).trim()) as SseMessage);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v) : v;
  return d.toLocaleString();
}

export function riskColor(r: string): string {
  return r === "R4" ? "bg-danger/20 text-danger border-danger/40" : r === "R3" ? "bg-warn/20 text-warn border-warn/40" : r === "R2" ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/30" : "bg-ok/15 text-ok border-ok/30";
}
