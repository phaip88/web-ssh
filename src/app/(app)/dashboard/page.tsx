"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime, riskColor } from "@/lib/client/api";
import { Badge, Card, Empty, Table } from "@/components/ui";

interface Host { id: string; name: string; environment: string; lastConnectedAt: string | null; lastLatencyMs: number | null; isFavorite: boolean }
interface Session { id: string; hostName: string; status: string; startedAt: string; live: boolean; environment: string }
interface Approval { id: string; summary: string; riskLevel: string; status: string; createdAt: string }
interface AuditEvent { seq: number; action: string; result: string; riskLevel: string; timestamp: string; resourceType: string }

export default function Dashboard() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  useEffect(() => {
    api<Host[]>("/api/hosts").then(setHosts).catch(() => undefined);
    api<Session[]>("/api/terminal/sessions").then(setSessions).catch(() => undefined);
    api<Approval[]>("/api/approvals?status=pending").then(setApprovals).catch(() => undefined);
    api<{ events: AuditEvent[] }>("/api/audit?limit=8").then((r) => setAudit(r.events)).catch(() => undefined);
  }, []);
  const live = sessions.filter((s) => s.live);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Hosts", hosts.length],
          ["Live sessions", live.length],
          ["Pending approvals", approvals.length],
          ["Production hosts", hosts.filter((h) => h.environment === "production").length],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-panel p-4">
            <div className="text-xs text-muted">{k}</div>
            <div className="mt-1 text-2xl font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Favourite & recent hosts" actions={<Link href="/terminal" className="text-xs text-accent">Open terminal →</Link>}>
          {hosts.length === 0 ? (
            <Empty>No hosts yet. <Link href="/hosts" className="text-accent">Add one</Link>.</Empty>
          ) : (
            <Table head={["Host", "Env", "Last connected", "Latency"]}>
              {hosts.slice(0, 8).map((h) => (
                <tr key={h.id} className="border-b border-border/60">
                  <td className="px-2 py-1.5">{h.isFavorite ? "★ " : ""}{h.name}</td>
                  <td className="px-2 py-1.5"><Badge className={h.environment === "production" ? "border-danger/40 text-danger" : undefined}>{h.environment}</Badge></td>
                  <td className="px-2 py-1.5 text-muted">{fmtTime(h.lastConnectedAt)}</td>
                  <td className="px-2 py-1.5 text-muted">{h.lastLatencyMs ? `${h.lastLatencyMs} ms` : "-"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Pending approvals">
          {approvals.length === 0 ? <Empty>Nothing waiting for approval.</Empty> : (
            <ul className="space-y-2">
              {approvals.map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded border border-border p-2 text-sm">
                  <span className="mono truncate">{a.summary}</span>
                  <Badge className={riskColor(a.riskLevel)}>{a.riskLevel}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent sessions">
          {sessions.length === 0 ? <Empty>No sessions yet.</Empty> : (
            <Table head={["Host", "Status", "Started"]}>
              {sessions.slice(0, 8).map((s) => (
                <tr key={s.id} className="border-b border-border/60">
                  <td className="px-2 py-1.5"><Link href={`/sessions/${s.id}`} className="hover:text-accent">{s.hostName}</Link></td>
                  <td className="px-2 py-1.5"><Badge className={s.live ? "border-ok/40 text-ok" : undefined}>{s.live ? "live" : s.status}</Badge></td>
                  <td className="px-2 py-1.5 text-muted">{fmtTime(s.startedAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Recent audit events" actions={<Link href="/audit" className="text-xs text-accent">All →</Link>}>
          {audit.length === 0 ? <Empty>No audit events visible (requires audit:read).</Empty> : (
            <ul className="space-y-1 text-xs">
              {audit.map((e) => (
                <li key={e.seq} className="flex items-center gap-2">
                  <Badge className={riskColor(e.riskLevel)}>{e.riskLevel}</Badge>
                  <span className="mono">{e.action}</span>
                  <span className={e.result === "success" ? "text-ok" : "text-danger"}>{e.result}</span>
                  <span className="ml-auto text-muted">{fmtTime(e.timestamp)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
