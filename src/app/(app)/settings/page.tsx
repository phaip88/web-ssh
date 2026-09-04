"use client";
import { useEffect, useState } from "react";
import { api, fmtTime, riskColor } from "@/lib/client/api";
import { Badge, Button, Card, Empty, ErrorText, Table, Textarea } from "@/components/ui";

interface Tool { name: string; description: string; permission: string; risk: string; requiresApproval: boolean; allowedInProduction: boolean; timeoutMs: number; maxOutputBytes: number }
interface Memory { id: string; scope: string; content: string; source: string; createdAt: string }
interface Usage { byModel: { model: string; requests: number; inputTokens: number; outputTokens: number; avgLatencyMs: number; failures: number }[]; byDay: { day: string; requests: number; inputTokens: number; outputTokens: number }[] }

export default function SettingsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [mem, setMem] = useState<Memory[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const loadMem = () => api<Memory[]>("/api/memories").then(setMem).catch(() => undefined);
  useEffect(() => {
    api<Tool[]>("/api/tools").then(setTools).catch(() => undefined);
    api<Usage>("/api/usage").then(setUsage).catch(() => undefined);
    void loadMem();
  }, []);
  const addMem = async () => {
    setErr(null);
    try {
      await api("/api/memories", { method: "POST", body: JSON.stringify({ scope: "user", content: text }) });
      setText("");
      void loadMem();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Long-term memory (user scope)">
          <p className="mb-2 text-xs text-muted">Memories are injected into the agent context with their source shown. Secret-like content is rejected. Delete anytime; tenant isolation is enforced server-side.</p>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Our app logs live in /var/log/app; prefer journalctl for services." />
          <div className="mt-2 flex items-center justify-between"><ErrorText>{err}</ErrorText><Button size="sm" disabled={!text.trim()} onClick={() => void addMem()}>Save memory</Button></div>
          <ul className="mt-3 space-y-1 text-xs">
            {mem.map((m) => (
              <li key={m.id} className="flex items-start gap-2 rounded border border-border p-2"><Badge>{m.scope}</Badge><span className="flex-1">{m.content}</span><span className="text-muted">{fmtTime(m.createdAt)}</span><button className="text-danger" onClick={() => api(`/api/memories?id=${m.id}`, { method: "DELETE" }).then(loadMem)}>✕</button></li>
            ))}
            {mem.length === 0 && <Empty>No memories stored.</Empty>}
          </ul>
        </Card>
        <Card title="Token usage (30 days)">
          {!usage || usage.byModel.length === 0 ? <Empty>No usage yet.</Empty> : (
            <Table head={["Model", "Requests", "In", "Out", "Avg latency", "Failures"]}>
              {usage.byModel.map((u) => (
                <tr key={u.model} className="border-b border-border/60 text-xs"><td className="mono px-2 py-1.5">{u.model}</td><td className="px-2 py-1.5">{u.requests}</td><td className="px-2 py-1.5">{u.inputTokens}</td><td className="px-2 py-1.5">{u.outputTokens}</td><td className="px-2 py-1.5">{u.avgLatencyMs} ms</td><td className="px-2 py-1.5">{u.failures}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card title="Agent tool registry (declared capabilities)">
        <Table head={["Tool", "Description", "Permission", "Risk", "Approval", "Prod", "Timeout", "Max output"]}>
          {tools.map((t) => (
            <tr key={t.name} className="border-b border-border/60 text-xs">
              <td className="mono px-2 py-1.5">{t.name}</td>
              <td className="px-2 py-1.5 text-muted">{t.description}</td>
              <td className="mono px-2 py-1.5">{t.permission}</td>
              <td className="px-2 py-1.5"><Badge className={riskColor(t.risk)}>{t.risk}</Badge></td>
              <td className="px-2 py-1.5">{t.requiresApproval ? "required" : "auto (Auto mode)"}</td>
              <td className="px-2 py-1.5">{t.allowedInProduction ? "yes" : "no"}</td>
              <td className="px-2 py-1.5">{t.timeoutMs / 1000}s</td>
              <td className="px-2 py-1.5">{Math.round(t.maxOutputBytes / 1024)} KiB</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
