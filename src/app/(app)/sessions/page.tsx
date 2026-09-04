"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { Badge, Button, Card, Empty, Table } from "@/components/ui";

interface Session { id: string; hostName: string; environment: string; status: string; closeReason: string | null; startedAt: string; endedAt: string | null; bytesIn: number; bytesOut: number; live: boolean; nodeId: string | null; userId: string }

export default function SessionsPage() {
  const [rows, setRows] = useState<Session[]>([]);
  const [all, setAll] = useState(false);
  const load = (a: boolean) => api<Session[]>(`/api/terminal/sessions${a ? "?all=true" : ""}`).then(setRows).catch(() => setAll(false));
  useEffect(() => { void load(all); }, [all]);
  const kill = async (id: string) => {
    if (!confirm("Terminate this session?")) return;
    await api(`/api/terminal/sessions/${id}`, { method: "DELETE" });
    void load(all);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all workspace sessions (requires sessions:read_all)</label>
      </div>
      <Card>
        {rows.length === 0 ? <Empty>No sessions.</Empty> : (
          <Table head={["Host", "Env", "Status", "Started", "Ended", "Traffic", "Node", ""]}>
            {rows.map((s) => (
              <tr key={s.id} className="border-b border-border/60">
                <td className="px-2 py-1.5"><Link className="hover:text-accent" href={`/sessions/${s.id}`}>{s.hostName}</Link></td>
                <td className="px-2 py-1.5"><Badge className={s.environment === "production" ? "border-danger/40 text-danger" : undefined}>{s.environment}</Badge></td>
                <td className="px-2 py-1.5"><Badge className={s.live ? "border-ok/40 text-ok" : s.status === "failed" ? "border-danger/40 text-danger" : undefined}>{s.live ? "live" : s.status}</Badge> <span className="text-xs text-muted">{s.closeReason}</span></td>
                <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(s.startedAt)}</td>
                <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(s.endedAt)}</td>
                <td className="px-2 py-1.5 text-xs text-muted">↑{s.bytesIn} ↓{s.bytesOut}</td>
                <td className="mono px-2 py-1.5 text-xs text-muted">{s.nodeId}</td>
                <td className="px-2 py-1.5 text-right">{s.live && <Button size="sm" variant="ghost" className="text-danger" onClick={() => void kill(s.id)}>Terminate</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
