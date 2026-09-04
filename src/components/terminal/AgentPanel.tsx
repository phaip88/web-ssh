"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, consumeSse, riskColor, type SseMessage } from "@/lib/client/api";
import { Badge, Button, Select, Textarea } from "@/components/ui";
import { useT } from "@/lib/client/i18n";
import { ApprovalDialog, type PendingApproval } from "./ApprovalDialog";
import type { Tab } from "./store";

type Mode = "ask" | "suggest" | "approval" | "auto" | "plan";
interface ChatItem { id: string; role: "user" | "assistant" | "tool" | "system"; content: string; tool?: { name: string; risk: string; decision: string; status?: string; input?: unknown; output?: unknown } }
interface Provider { id: string; name: string; defaultModel: string; isDefault: boolean }

function renderMarkdown(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(md);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _l, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/^(?:- (.*)(?:\n|$))+/gm, (block) => `<ul>${block.trim().split("\n").map((l) => `<li>${l.replace(/^- /, "")}</li>`).join("")}</ul>`);
  html = html.replace(/^(\d+)\. (.*)$/gm, "<p>$1. $2</p>");
  html = html.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br/>");
  return `<p>${html}</p>`;
}

export function AgentPanel({ tab, permissions }: { tab: Tab | null; permissions: string[] }) {
  const t = useT();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("approval");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const streamRef = useRef<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const convBySession = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    api<Provider[]>("/api/providers").then((p) => {
      setProviders(p);
      setProviderId(p.find((x) => x.isDefault)?.id ?? p[0]?.id ?? "");
    }).catch(() => undefined);
  }, []);

  // One conversation per terminal tab.
  useEffect(() => {
    setItems([]);
    setPending(null);
    setConversationId(tab ? (convBySession.current.get(tab.id) ?? null) : null);
  }, [tab?.id, tab]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, status]);

  const handle = useCallback((m: SseMessage) => {
    switch (m.type) {
      case "agent.status":
        setStatus(String(m.status));
        if (m.status === "failed") setItems((it) => [...it, { id: m.id, role: "system", content: `Run failed: ${String(m.error ?? "")}` }]);
        break;
      case "agent.delta": {
        streamRef.current += String(m.delta);
        const text = streamRef.current;
        setItems((it) => {
          const last = it[it.length - 1];
          if (last && last.id === "streaming") return [...it.slice(0, -1), { ...last, content: text }];
          return [...it, { id: "streaming", role: "assistant", content: text }];
        });
        break;
      }
      case "agent.message":
        streamRef.current = "";
        setItems((it) => [...it.filter((x) => x.id !== "streaming"), { id: String(m.messageId), role: "assistant", content: String(m.content) }]);
        break;
      case "agent.tool.request":
        setItems((it) => [...it, { id: String(m.toolCallId), role: "tool", content: "", tool: { name: String(m.tool), risk: String(m.risk), decision: String(m.decision), input: m.input } }]);
        break;
      case "agent.tool.result":
        setItems((it) => it.map((x) => (x.id === m.toolCallId && x.tool ? { ...x, tool: { ...x.tool, status: String(m.status), output: m.output } } : x)));
        break;
      case "approval.required":
        setPending({ approvalId: String(m.approvalId), toolCallId: String(m.toolCallId), runId: String(m.runId), summary: String(m.summary), risk: String(m.risk), details: m.details as PendingApproval["details"], hostName: tab?.hostName ?? "" });
        break;
      case "approval.result":
        setPending(null);
        break;
    }
  }, [tab?.hostName]);

  const ensureConversation = async (): Promise<string> => {
    if (conversationId) return conversationId;
    const c = await api<{ id: string }>("/api/agent/conversations", { method: "POST", body: JSON.stringify({ terminalSessionId: tab?.id, hostId: tab?.hostId, mode, providerId: providerId || undefined }) });
    if (tab) convBySession.current.set(tab.id, c.id);
    setConversationId(c.id);
    return c.id;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setInput("");
    setItems((it) => [...it, { id: `u-${Date.now()}`, role: "user", content }]);
    try {
      const id = await ensureConversation();
      const res = await fetch(`/api/agent/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      await consumeSse(res, handle);
    } catch (err) {
      setItems((it) => [...it, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : "failed" }]);
    } finally {
      setBusy(false);
      setStatus("idle");
    }
  };

  const decide = async (decision: "approved" | "rejected", note?: string) => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/${pending.approvalId}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, note }) });
      setPending(null);
      await consumeSse(res, handle);
    } catch (err) {
      setItems((it) => [...it, { id: `e-${Date.now()}`, role: "system", content: err instanceof Error ? err.message : "failed" }]);
    } finally {
      setBusy(false);
      setStatus("idle");
    }
  };

  const changeMode = async (m: Mode) => {
    setMode(m);
    if (conversationId) await api(`/api/agent/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify({ mode: m }) }).catch(() => undefined);
  };
  const canAuto = permissions.includes("agent:auto");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">{t("agent")}</span>
        <Select className="ml-auto w-28" value={mode} onChange={(e) => void changeMode(e.target.value as Mode)}>
          <option value="ask">Ask</option>
          <option value="suggest">Suggest</option>
          <option value="approval">Approval</option>
          <option value="plan">Plan</option>
          {canAuto && <option value="auto">Auto</option>}
        </Select>
        <Select className="w-36" value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={!!conversationId}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3 text-sm">
        {!tab && <p className="text-xs text-muted">{t("noSession")}</p>}
        {tab && items.length === 0 && (
          <div className="rounded border border-dashed border-border p-3 text-xs text-muted">
            Attached to <b>{tab.hostName}</b>. Mode <b>{mode}</b>: {mode === "approval" ? "every tool call is shown for approval." : mode === "suggest" ? "commands are suggested, never executed." : mode === "ask" ? "answers only." : mode === "plan" ? "a plan is produced before any action." : "low-risk read-only tools run automatically."}
            <div className="mt-2 flex flex-wrap gap-1">
              {["Analyze the latest errors in the app log", "Why is the disk almost full?", "Check memory and the OOM kill", "Delete everything under /var/lib/app"].map((q) => (
                <button key={q} className="rounded border border-border px-1.5 py-0.5 hover:bg-panel-2" onClick={() => setInput(q)}>{q}</button>
              ))}
            </div>
          </div>
        )}
        {items.map((it) => (
          <div key={it.id} className={it.role === "user" ? "ml-6 rounded-lg bg-accent/15 px-3 py-2" : it.role === "system" ? "rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" : it.role === "tool" ? "rounded border border-border bg-panel-2 px-3 py-2 text-xs" : "prose-chat rounded-lg border border-border px-3 py-2"}>
            {it.role === "tool" && it.tool ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="mono font-semibold">{it.tool.name}</span>
                  <Badge className={riskColor(it.tool.risk)}>{it.tool.risk}</Badge>
                  <Badge className={it.tool.decision === "blocked" ? "border-danger/40 text-danger" : it.tool.decision === "allow" ? "border-ok/40 text-ok" : "border-warn/40 text-warn"}>{it.tool.decision}</Badge>
                  {it.tool.status && <Badge>{it.tool.status}</Badge>}
                </div>
                <pre className="mono overflow-x-auto whitespace-pre-wrap">{typeof (it.tool.input as { command?: string })?.command === "string" ? `$ ${(it.tool.input as { command: string }).command}` : JSON.stringify(it.tool.input)}</pre>
                {it.tool.output !== undefined && (
                  <details>
                    <summary className="cursor-pointer text-muted">output</summary>
                    <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{typeof (it.tool.output as { stdout?: string })?.stdout === "string" ? ((it.tool.output as { stdout: string; stderr?: string }).stdout + ((it.tool.output as { stderr?: string }).stderr ?? "")) : JSON.stringify(it.tool.output, null, 2)}</pre>
                  </details>
                )}
              </div>
            ) : it.role === "assistant" ? (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(it.content) }} />
            ) : (
              <span className="whitespace-pre-wrap">{it.content}</span>
            )}
          </div>
        ))}
        {status !== "idle" && <div className="text-xs text-muted">● {status}…</div>}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border p-2">
        <Textarea rows={2} value={input} placeholder={t("askPlaceholder")} disabled={!tab || busy} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
          <span>Terminal output & files are treated as untrusted data.</span>
          <Button size="sm" disabled={!tab || busy || !input.trim()} onClick={() => void send()}>{t("send")}</Button>
        </div>
      </div>
      <ApprovalDialog approval={pending} onDecide={(d, n) => void decide(d, n)} busy={busy} />
    </div>
  );
}
