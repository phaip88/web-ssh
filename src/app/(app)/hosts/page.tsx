"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Input, Label, Select, Table } from "@/components/ui";

interface Host { id: string; name: string; host: string; port: number; username: string; authType: string; credentialId: string | null; environment: string; labels: string[]; hostKeyPolicy: string; isFavorite: boolean; lastConnectedAt: string | null; version: number }
interface Credential { id: string; name: string; type: string }

const empty = { name: "", host: "", port: 22, username: "", authType: "password", credentialId: "", environment: "development", labels: "", hostKeyPolicy: "strict", isFavorite: false };

export default function HostsPage() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = () => {
    api<Host[]>("/api/hosts").then(setHosts).catch((e) => setError(e.message));
    api<Credential[]>("/api/credentials").then(setCreds).catch(() => undefined);
  };
  useEffect(load, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = { ...form, port: Number(form.port), credentialId: form.credentialId || null, labels: form.labels.split(",").map((s) => s.trim()).filter(Boolean) };
    try {
      if (editId) {
        const h = hosts.find((x) => x.id === editId);
        await api(`/api/hosts/${editId}`, { method: "PATCH", body: JSON.stringify({ ...body, version: h?.version }) });
      } else await api("/api/hosts", { method: "POST", body: JSON.stringify(body) });
      setOpen(false);
      setForm(empty);
      setEditId(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };
  const edit = (h: Host) => {
    setEditId(h.id);
    setForm({ name: h.name, host: h.host, port: h.port, username: h.username, authType: h.authType, credentialId: h.credentialId ?? "", environment: h.environment, labels: h.labels.join(", "), hostKeyPolicy: h.hostKeyPolicy, isFavorite: h.isFavorite });
    setOpen(true);
  };
  const duplicate = (h: Host) => {
    setEditId(null);
    setForm({ name: `${h.name} (copy)`, host: h.host, port: h.port, username: h.username, authType: h.authType, credentialId: h.credentialId ?? "", environment: h.environment, labels: h.labels.join(", "), hostKeyPolicy: h.hostKeyPolicy, isFavorite: false });
    setOpen(true);
  };
  const remove = async (h: Host) => {
    if (!confirm(`Delete host ${h.name}?`)) return;
    await api(`/api/hosts/${h.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    load();
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(hosts.map(({ id: _i, version: _v, lastConnectedAt: _l, ...h }) => h), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hosts.json";
    a.click();
  };
  const importJson = async (file: File) => {
    try {
      const list = JSON.parse(await file.text()) as Partial<Host>[];
      for (const h of list) await api("/api/hosts", { method: "POST", body: JSON.stringify({ ...h, credentialId: h.credentialId ?? null }) });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  };
  const filtered = hosts.filter((h) => !q || `${h.name} ${h.host} ${h.labels.join(" ")} ${h.environment}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Hosts</h1>
        <Input className="max-w-xs" placeholder="Fuzzy search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto flex gap-2">
          <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm hover:bg-panel-2">Import JSON<input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])} /></label>
          <Button variant="outline" onClick={exportJson}>Export JSON</Button>
          <Button onClick={() => { setEditId(null); setForm(empty); setOpen(true); }}>Add host</Button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      <Card>
        {filtered.length === 0 ? <Empty>No hosts match.</Empty> : (
          <Table head={["Name", "Address", "Env", "Labels", "Auth", "Host key", "Last connected", ""]}>
            {filtered.map((h) => (
              <tr key={h.id} className="border-b border-border/60">
                <td className="px-2 py-1.5"><Link href={`/hosts/${h.id}`} className="hover:text-accent">{h.isFavorite ? "★ " : ""}{h.name}</Link></td>
                <td className="mono px-2 py-1.5 text-xs">{h.username}@{h.host}:{h.port}</td>
                <td className="px-2 py-1.5"><Badge className={h.environment === "production" ? "border-danger/40 text-danger" : undefined}>{h.environment}</Badge></td>
                <td className="px-2 py-1.5 text-xs text-muted">{h.labels.join(", ")}</td>
                <td className="px-2 py-1.5 text-xs">{h.authType}{!h.credentialId && <span className="text-warn"> (no credential)</span>}</td>
                <td className="px-2 py-1.5 text-xs">{h.hostKeyPolicy}</td>
                <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(h.lastConnectedAt)}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => edit(h)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(h)}>Copy</Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove(h)}>Delete</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title={editId ? "Edit host" : "Add host"}>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Name</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Host</Label><Input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
          <div><Label>Port</Label><Input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></div>
          <div><Label>Username</Label><Input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
          <div><Label>Auth type</Label><Select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })}><option value="password">password</option><option value="private_key">private_key</option></Select></div>
          <div className="col-span-2"><Label>Credential</Label><Select value={form.credentialId} onChange={(e) => setForm({ ...form, credentialId: e.target.value })}><option value="">— none —</option>{creds.filter((c) => c.type === form.authType).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
          <div><Label>Environment</Label><Select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}><option>development</option><option>staging</option><option>production</option></Select></div>
          <div><Label>Host key policy</Label><Select value={form.hostKeyPolicy} onChange={(e) => setForm({ ...form, hostKeyPolicy: e.target.value })}><option value="strict">strict (approve fingerprint)</option><option value="tofu">tofu (trust on first use)</option></Select></div>
          <div className="col-span-2"><Label>Labels (comma separated)</Label><Input value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} /></div>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isFavorite} onChange={(e) => setForm({ ...form, isFavorite: e.target.checked })} /> Favourite</label>
          <ErrorText>{error}</ErrorText>
          <div className="col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Save</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
