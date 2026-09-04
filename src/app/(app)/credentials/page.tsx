"use client";
import { useEffect, useState } from "react";
import { api, fmtTime } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Input, Label, Select, Table, Textarea } from "@/components/ui";

interface Credential { id: string; name: string; type: string; fingerprint: string | null; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string }

export default function CredentialsPage() {
  const [rows, setRows] = useState<Credential[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", type: "password", password: "", privateKey: "", passphrase: "" });
  const load = () => api<Credential[]>("/api/credentials").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/credentials", { method: "POST", body: JSON.stringify({ name: form.name, type: form.type, password: form.type === "password" ? form.password : undefined, privateKey: form.type === "private_key" ? form.privateKey : undefined, passphrase: form.passphrase || undefined }) });
      setOpen(false);
      setForm({ name: "", type: "password", password: "", privateKey: "", passphrase: "" });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };
  const revoke = async (c: Credential, hard: boolean) => {
    if (!confirm(`${hard ? "Delete" : "Revoke"} credential ${c.name}?`)) return;
    await api(`/api/credentials/${c.id}${hard ? "" : "?mode=revoke"}`, { method: "DELETE" }).catch((e) => setError(e.message));
    void load();
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Credentials</h1>
        <Button className="ml-auto" onClick={() => setOpen(true)}>Add credential</Button>
      </div>
      <p className="text-xs text-muted">Secrets are envelope-encrypted (AES-256-GCM, per-record DEK) and are never returned by the API or sent to the browser after creation.</p>
      <ErrorText>{error}</ErrorText>
      <Card>
        {rows.length === 0 ? <Empty>No credentials.</Empty> : (
          <Table head={["Name", "Type", "Fingerprint", "Last used", "Expires", "Status", ""]}>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-border/60">
                <td className="px-2 py-1.5">{c.name}</td>
                <td className="px-2 py-1.5">{c.type}</td>
                <td className="mono px-2 py-1.5 text-xs text-muted">{c.fingerprint ?? "••••••••"}</td>
                <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(c.lastUsedAt)}</td>
                <td className="px-2 py-1.5 text-xs text-muted">{fmtTime(c.expiresAt)}</td>
                <td className="px-2 py-1.5"><Badge className={c.revokedAt ? "border-danger/40 text-danger" : "border-ok/40 text-ok"}>{c.revokedAt ? "revoked" : "active"}</Badge></td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  {!c.revokedAt && <Button size="sm" variant="ghost" onClick={() => void revoke(c, false)}>Revoke</Button>}
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void revoke(c, true)}>Delete</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add credential">
        <form onSubmit={submit} className="space-y-3">
          <div><Label>Name</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Type</Label><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="password">password</option><option value="private_key">private_key</option></Select></div>
          {form.type === "password" ? (
            <div><Label>Password</Label><Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          ) : (
            <>
              <div><Label>Private key (PEM / OpenSSH)</Label><Textarea rows={6} className="mono text-xs" value={form.privateKey} onChange={(e) => setForm({ ...form, privateKey: e.target.value })} /></div>
              <div><Label>Passphrase (optional)</Label><Input type="password" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} /></div>
            </>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Save</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
