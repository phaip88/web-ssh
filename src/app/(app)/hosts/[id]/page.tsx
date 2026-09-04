"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { Badge, Button, Card, Empty, Table } from "@/components/ui";

interface HostKey { id: string; keyType: string; fingerprintSha256: string; status: string; approvedAt: string | null; createdAt: string }
interface Host { id: string; name: string; host: string; port: number; username: string; environment: string; labels: string[]; hostKeyPolicy: string; keepaliveInterval: number; connectionTimeout: number; maxSessionDuration: number; lastConnectedAt: string | null; lastLatencyMs: number | null; hostKeys: HostKey[] }

export default function HostDetail() {
  const { id } = useParams<{ id: string }>();
  const [host, setHost] = useState<Host | null>(null);
  const load = useCallback(() => api<Host>(`/api/hosts/${id}`).then(setHost).catch(() => undefined), [id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (keyId: string, action: "trust" | "revoke") => {
    await api(`/api/hosts/${id}/host-keys`, { method: "POST", body: JSON.stringify({ keyId, action }) });
    void load();
  };
  if (!host) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold">{host.name} <Badge className={host.environment === "production" ? "border-danger/40 text-danger" : undefined}>{host.environment}</Badge></h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm">
            <dt className="text-muted">Address</dt><dd className="mono">{host.username}@{host.host}:{host.port}</dd>
            <dt className="text-muted">Labels</dt><dd>{host.labels.join(", ") || "-"}</dd>
            <dt className="text-muted">Host key policy</dt><dd>{host.hostKeyPolicy}</dd>
            <dt className="text-muted">Keepalive / timeout</dt><dd>{host.keepaliveInterval}s / {host.connectionTimeout}s</dd>
            <dt className="text-muted">Max session</dt><dd>{Math.round(host.maxSessionDuration / 3600)}h</dd>
            <dt className="text-muted">Last connected</dt><dd>{fmtTime(host.lastConnectedAt)} {host.lastLatencyMs ? `(${host.lastLatencyMs} ms)` : ""}</dd>
          </dl>
        </Card>
        <Card title="Known host keys">
          {host.hostKeys.length === 0 ? <Empty>No host key recorded yet. The first connection will present one for approval.</Empty> : (
            <Table head={["Type", "SHA256 fingerprint", "Status", "Seen", ""]}>
              {host.hostKeys.map((k) => (
                <tr key={k.id} className="border-b border-border/60">
                  <td className="px-2 py-1.5">{k.keyType}</td>
                  <td className="mono px-2 py-1.5 text-xs break-all">{k.fingerprintSha256}</td>
                  <td className="px-2 py-1.5"><Badge className={k.status === "trusted" ? "border-ok/40 text-ok" : k.status === "revoked" ? "border-danger/40 text-danger" : "border-warn/40 text-warn"}>{k.status}</Badge></td>
                  <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(k.createdAt)}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {k.status !== "trusted" && <Button size="sm" variant="ghost" onClick={() => void act(k.id, "trust")}>Trust</Button>}
                    {k.status !== "revoked" && <Button size="sm" variant="ghost" className="text-danger" onClick={() => void act(k.id, "revoke")}>Revoke</Button>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
