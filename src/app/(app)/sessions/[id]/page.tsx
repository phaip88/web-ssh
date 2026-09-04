"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { Badge, Button, Card } from "@/components/ui";

interface Ev { seq: number; kind: string; offsetMs: number; data: string; redacted: boolean }
interface Payload { session: { id: string; status: string; startedAt: string; endedAt: string | null; closeReason: string | null; title: string | null }; events: Ev[] }

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Session replay: streams recorded output into xterm with original timing (speed adjustable). */
export default function ReplayPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [speed, setSpeed] = useState(4);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);

  useEffect(() => {
    api<Payload>(`/api/terminal/sessions/${id}`).then(setData).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    if (!ref.current || !data) return;
    let disposed = false;
    void (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !ref.current) return;
      const term = new Terminal({ fontSize: 13, theme: { background: "#0b0f14" }, disableStdin: true, scrollback: 10000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();
      termRef.current = term;
    })();
    return () => {
      disposed = true;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [data]);

  useEffect(() => {
    if (!playing || !data) return;
    const outputs = data.events.filter((e) => e.kind === "output");
    if (pos >= outputs.length) {
      setPlaying(false);
      return;
    }
    const cur = outputs[pos];
    const prev = outputs[pos - 1];
    const delay = prev ? Math.min(2000, (cur.offsetMs - prev.offsetMs) / speed) : 0;
    const t = setTimeout(() => {
      termRef.current?.write(b64(cur.data));
      setPos((p) => p + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [playing, pos, data, speed]);

  const restart = () => {
    termRef.current?.reset();
    setPos(0);
    setPlaying(true);
  };
  const markers = data?.events.filter((e) => e.kind !== "output" && e.kind !== "resize") ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Replay · {data?.session.title ?? id}</h1>
        {data && <Badge>{data.session.status}</Badge>}
        <span className="text-xs text-muted">{data ? `${fmtTime(data.session.startedAt)} → ${fmtTime(data.session.endedAt)} · ${data.session.closeReason ?? ""}` : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
          <Button size="sm" variant="outline" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</Button>
          <Button size="sm" onClick={restart}>Restart</Button>
        </div>
      </div>
      <div ref={ref} className="h-[60vh] rounded-lg border border-border bg-[#0b0f14] p-1" />
      <Card title={`Timeline (${markers.length} non-output events: input, AI suggestions, AI executions, approvals)`}>
        <ul className="max-h-64 space-y-1 overflow-auto text-xs">
          {markers.map((e) => (
            <li key={e.seq} className="flex items-start gap-2">
              <span className="mono w-16 text-muted">{(e.offsetMs / 1000).toFixed(1)}s</span>
              <Badge className={e.kind === "ai_exec" ? "border-warn/40 text-warn" : e.kind === "approval" ? "border-accent/40 text-accent" : undefined}>{e.kind}</Badge>
              <span className="mono break-all">{e.redacted ? "[redacted sensitive input]" : e.kind === "input" ? JSON.stringify(e.data) : e.data.slice(0, 300)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
