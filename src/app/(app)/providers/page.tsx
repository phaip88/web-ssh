"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Input, Label, Select, Table } from "@/components/ui";

interface Provider { id: string; name: string; kind: string; baseUrl: string | null; defaultModel: string; isDefault: boolean; enabled: boolean; ownerUserId: string | null; hasApiKey: boolean; contextWindow: number }

const empty = { name: "", kind: "openai_compatible", baseUrl: "", apiKey: "", defaultModel: "", contextWindow: 128000, maxOutputTokens: 4096, isDefault: false, private: false, streamingEnabled: true };

export default function ProvidersPage() {
  const [rows, setRows] = useState<Provider[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, string>>({});
  const load = () => api<Provider[]>("/api/providers").then(setRows).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/providers", { method: "POST", body: JSON.stringify({ ...form, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey || undefined }) });
      setOpen(false);
      setForm(empty);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  };
  const test = async (p: Provider) => {
    setHealth((h) => ({ ...h, [p.id]: "testing…" }));
    try {
      const r = await api<{ ok: boolean; latencyMs: number; message?: string; models: string[] }>(`/api/providers/${p.id}`, { method: "POST" });
      setHealth((h) => ({ ...h, [p.id]: r.ok ? `ok ${r.latencyMs}ms · ${r.models.length} models` : `failed: ${r.message}` }));
    } catch (err) {
      setHealth((h) => ({ ...h, [p.id]: err instanceof Error ? err.message : "failed" }));
    }
  };
  const remove = async (p: Provider) => {
    if (!confirm(`Delete provider ${p.name}?`)) return;
    await api(`/api/providers/${p.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    void load();
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Model providers</h1>
        <Button className="ml-auto" onClick={() => setOpen(true)}>Add provider</Button>
      </div>
      <p className="text-xs text-muted">Custom base URLs are validated against SSRF rules (HTTPS only in production, no private/link-local/metadata destinations, redirects re-validated). API keys are envelope-encrypted and only masked tails appear in audit logs.</p>
      <ErrorText>{error}</ErrorText>
      <Card>
        {rows.length === 0 ? <Empty>No providers configured.</Empty> : (
          <Table head={["Name", "Kind", "Base URL", "Default model", "Scope", "Key", "Health", ""]}>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-border/60">
                <td className="px-2 py-1.5">{p.name} {p.isDefault && <Badge className="border-accent/40 text-accent">default</Badge>}</td>
                <td className="px-2 py-1.5">{p.kind}</td>
                <td className="mono px-2 py-1.5 text-xs text-muted">{p.baseUrl ?? "-"}</td>
                <td className="mono px-2 py-1.5 text-xs">{p.defaultModel}</td>
                <td className="px-2 py-1.5 text-xs">{p.ownerUserId ? "private" : "tenant"}</td>
                <td className="px-2 py-1.5 text-xs">{p.hasApiKey ? "••••" : "-"}</td>
                <td className="px-2 py-1.5 text-xs text-muted">{health[p.id] ?? ""}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => void test(p)}>Test</Button><Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove(p)}>Delete</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add provider">
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Name</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Kind</Label><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{["openai", "openai_compatible", "azure_openai", "anthropic", "ollama", "vllm", "mock"].map((k) => <option key={k}>{k}</option>)}</Select></div>
          <div><Label>Default model</Label><Input required value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} placeholder="gpt-4o-mini / claude-sonnet-4-5 / llama3" /></div>
          <div className="col-span-2"><Label>Base URL (optional)</Label><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></div>
          <div className="col-span-2"><Label>API key</Label><Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
          <div><Label>Context window</Label><Input type="number" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) })} /></div>
          <div><Label>Max output tokens</Label><Input type="number" value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: Number(e.target.value) })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Tenant default</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.private} onChange={(e) => setForm({ ...form, private: e.target.checked })} /> Private (only me)</label>
          <ErrorText>{error}</ErrorText>
          <div className="col-span-2 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Save</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
