"use client";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, riskColor } from "@/lib/client/api";
import { Badge, Button, Card, Empty, Input, Select, Table } from "@/components/ui";

interface Ev { seq: number; eventId: string; timestamp: string; actorId: string | null; action: string; resourceType: string; resourceId: string | null; result: string; riskLevel: string; sourceIp: string | null; sessionId: string | null; metadata: Record<string, unknown>; integrityHash: string }

export default function AuditPage() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null);
  const [f, setF] = useState({ action: "", result: "", riskLevel: "" });
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback((v = false) => {
    const q = new URLSearchParams({ limit: "200", ...(f.action ? { action: f.action } : {}), ...(f.result ? { result: f.result } : {}), ...(f.riskLevel ? { riskLevel: f.riskLevel } : {}), ...(v ? { verify: "true" } : {}) });
    api<{ events: Ev[]; verify: typeof verify }>(`/api/audit?${q}`).then((r) => { setEvents(r.events); setVerify(r.verify); }).catch((e) => setErr(e.message));
  }, [f]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Audit log</h1>
        <Input className="max-w-48" placeholder="action contains…" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
        <Select className="w-32" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="">any result</option><option>success</option><option>failure</option><option>denied</option></Select>
        <Select className="w-28" value={f.riskLevel} onChange={(e) => setF({ ...f, riskLevel: e.target.value })}><option value="">any risk</option>{["R0", "R1", "R2", "R3", "R4"].map((r) => <option key={r}>{r}</option>)}</Select>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => load(true)}>Verify hash chain</Button>
          <a className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-panel-2" href="/api/audit?format=csv&limit=500">Export CSV</a>
        </div>
      </div>
      {verify && <p className={`text-xs ${verify.ok ? "text-ok" : "text-danger"}`}>{verify.ok ? `Integrity chain verified for ${verify.checked} events.` : `Chain BROKEN at seq ${verify.brokenAt}`}</p>}
      {err && <p className="text-xs text-danger">{err}</p>}
      <Card>
        {events.length === 0 ? <Empty>No events (requires audit:read).</Empty> : (
          <Table head={["Seq", "Time", "Action", "Resource", "Result", "Risk", "Actor", "IP", ""]}>
            {events.map((e) => (
              <>
                <tr key={e.seq} className="border-b border-border/60 text-xs">
                  <td className="px-2 py-1.5 text-muted">{e.seq}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmtTime(e.timestamp)}</td>
                  <td className="mono px-2 py-1.5">{e.action}</td>
                  <td className="px-2 py-1.5 text-muted">{e.resourceType}</td>
                  <td className={`px-2 py-1.5 ${e.result === "success" ? "text-ok" : "text-danger"}`}>{e.result}</td>
                  <td className="px-2 py-1.5"><Badge className={riskColor(e.riskLevel)}>{e.riskLevel}</Badge></td>
                  <td className="mono px-2 py-1.5 text-muted">{e.actorId?.slice(0, 8) ?? "-"}</td>
                  <td className="px-2 py-1.5 text-muted">{e.sourceIp ?? "-"}</td>
                  <td className="px-2 py-1.5"><button className="text-accent" onClick={() => setOpen(open === e.seq ? null : e.seq)}>{open === e.seq ? "hide" : "meta"}</button></td>
                </tr>
                {open === e.seq && (
                  <tr key={`${e.seq}-m`}><td colSpan={9} className="bg-panel-2 px-3 py-2"><pre className="mono max-h-48 overflow-auto text-[11px]">{JSON.stringify({ eventId: e.eventId, sessionId: e.sessionId, resourceId: e.resourceId, metadata: e.metadata, integrityHash: e.integrityHash }, null, 2)}</pre></td></tr>
                )}
              </>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
