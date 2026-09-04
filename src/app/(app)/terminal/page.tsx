"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ClientApiError } from "@/lib/client/api";
import { Badge, Button, Dialog, Input } from "@/components/ui";
import { useT } from "@/lib/client/i18n";
import { AgentPanel } from "@/components/terminal/AgentPanel";
import { useTerminalStore } from "@/components/terminal/store";
import type { Me } from "../layout";

const TerminalView = dynamic(() => import("@/components/terminal/TerminalView").then((m) => m.TerminalView), { ssr: false });

interface Host { id: string; name: string; host: string; port: number; username: string; environment: string; labels: string[]; isFavorite: boolean; lastLatencyMs: number | null }
interface HostKeyPrompt { host: Host; fingerprint: string; keyType: string; mismatch: boolean }

export default function TerminalPage() {
  const t = useT();
  const { tabs, activeId, split, addTab, closeTab, setActive, toggleSplit } = useTerminalStore();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [filter, setFilter] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [keyPrompt, setKeyPrompt] = useState<HostKeyPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);

  useEffect(() => {
    api<Host[]>("/api/hosts").then(setHosts).catch(() => undefined);
    api<Me>("/api/auth/me").then(setMe).catch(() => undefined);
  }, []);

  const permissions = me?.workspaces[0]?.permissions ?? [];
  const connect = useCallback(async (host: Host) => {
    setError(null);
    try {
      const s = await api<{ id: string; connectMs: number }>("/api/terminal/sessions", { method: "POST", body: JSON.stringify({ hostId: host.id, cols: 120, rows: 32 }) });
      addTab({ id: s.id, hostId: host.id, hostName: host.name, environment: host.environment, status: "connecting", latencyMs: s.connectMs, lastSeq: 0, title: host.name });
    } catch (err) {
      if (err instanceof ClientApiError && (err.code === "HOST_KEY_UNKNOWN" || err.code === "HOST_KEY_MISMATCH")) {
        const d = err.details as { fingerprint: string; keyType: string } | undefined;
        setKeyPrompt({ host, fingerprint: d?.fingerprint ?? "?", keyType: d?.keyType ?? "?", mismatch: err.code === "HOST_KEY_MISMATCH" });
      } else setError(err instanceof Error ? err.message : "Connection failed");
    }
  }, [addTab]);

  const trustAndConnect = async () => {
    if (!keyPrompt) return;
    try {
      await api(`/api/hosts/${keyPrompt.host.id}/host-keys`, { method: "POST", body: JSON.stringify({ fingerprint: keyPrompt.fingerprint, action: "trust" }) });
      const h = keyPrompt.host;
      setKeyPrompt(null);
      await connect(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trust key");
    }
  };

  const close = async (id: string) => {
    closeTab(id);
    await api(`/api/terminal/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
  };

  const active = tabs.find((x) => x.id === activeId) ?? null;
  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const list = hosts.filter((h) => !f || h.name.toLowerCase().includes(f) || h.host.includes(f) || h.labels.some((l) => l.includes(f)));
    const g: Record<string, Host[]> = {};
    for (const h of list) (g[h.environment] ??= []).push(h);
    return g;
  }, [hosts, filter]);
  const visibleTabs = split ? tabs.slice(-2) : active ? [active] : [];

  return (
    <div className="flex h-full min-h-0">
      {/* left: hosts / sessions tree */}
      <aside className={`${leftOpen ? "w-60" : "w-0"} hidden shrink-0 flex-col overflow-hidden border-r border-border bg-panel transition-all md:flex`}>
        <div className="p-2"><Input placeholder="Search hosts, labels…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 text-sm">
          {Object.entries(groups).map(([env, list]) => (
            <div key={env} className="mb-2">
              <div className={`px-1 text-[10px] font-semibold uppercase tracking-wider ${env === "production" ? "text-danger" : "text-muted"}`}>{env}</div>
              {list.map((h) => (
                <button key={h.id} onClick={() => void connect(h)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2" title={`${h.username}@${h.host}:${h.port}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${tabs.some((x) => x.hostId === h.id && x.status === "active") ? "bg-ok" : "bg-border"}`} />
                  <span className="truncate">{h.isFavorite ? "★ " : ""}{h.name}</span>
                </button>
              ))}
            </div>
          ))}
          {hosts.length === 0 && <p className="p-2 text-xs text-muted">No hosts. Add one under Hosts.</p>}
          <div className="mt-3 border-t border-border pt-2">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{t("sessions")}</div>
            {tabs.map((x) => (
              <div key={x.id} className={`flex items-center gap-2 rounded px-1.5 py-1 ${x.id === activeId ? "bg-accent/15" : ""}`}>
                <button className="flex-1 truncate text-left" onClick={() => setActive(x.id)}>{x.title}</button>
                <Badge className={x.status === "active" ? "border-ok/40 text-ok" : x.status === "closed" ? "border-danger/40 text-danger" : undefined}>{x.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* center */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-panel px-1">
          <button className="hidden px-1.5 text-muted md:block" onClick={() => setLeftOpen((o) => !o)} title="Toggle hosts">⫷</button>
          {tabs.map((x) => (
            <div key={x.id} onClick={() => setActive(x.id)} className={`group flex cursor-pointer items-center gap-2 border-b-2 px-3 py-1.5 text-xs ${x.id === activeId ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"} ${x.environment === "production" ? "bg-danger/10" : ""}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${x.status === "active" ? "bg-ok" : x.status === "closed" ? "bg-danger" : "bg-warn"}`} />
              <span className="max-w-40 truncate">{x.title}</span>
              {x.environment === "production" && <span className="text-[9px] font-bold text-danger">PROD</span>}
              <button className="text-muted opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); void close(x.id); }}>✕</button>
            </div>
          ))}
          <div className="ml-auto flex items-center gap-1 pr-1">
            <Button size="sm" variant="ghost" onClick={toggleSplit} title="Split view">{split ? "▭" : "▯▯"}</Button>
            <Button size="sm" variant="ghost" onClick={() => setRightOpen((o) => !o)} title="Toggle agent">✦</Button>
          </div>
        </div>
        {error && <div className="border-b border-danger/40 bg-danger/10 px-3 py-1 text-xs text-danger">{error}</div>}
        <div className={`min-h-0 flex-1 bg-bg ${split ? "grid grid-cols-1 gap-px lg:grid-cols-2" : ""}`}>
          {tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
              <div className="mono text-3xl">&gt;_</div>
              <p>Select a host on the left to open a terminal.</p>
              <p className="text-xs">Shortcuts: Ctrl+Shift+F search · Ctrl+Shift+C copy</p>
            </div>
          )}
          {tabs.map((x) => (
            <div key={x.id} className={`relative h-full min-h-0 p-1 ${visibleTabs.some((v) => v.id === x.id) ? "" : "hidden"}`}>
              {x.environment === "production" && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-danger" />}
              <TerminalView sessionId={x.id} visible={visibleTabs.some((v) => v.id === x.id)} />
            </div>
          ))}
        </div>
        {/* bottom status bar */}
        <footer className={`flex items-center gap-3 border-t border-border px-3 py-1 text-[11px] ${active?.environment === "production" ? "bg-danger/15 text-danger" : "bg-panel text-muted"}`}>
          <span className={`h-2 w-2 rounded-full ${active?.status === "active" ? "bg-ok" : active ? "bg-warn" : "bg-border"}`} />
          <span>{active ? `${active.hostName} · ${active.status}` : "no session"}</span>
          {active && <span>{t("latency")}: {active.latencyMs ?? "-"} ms</span>}
          {active?.environment === "production" && <span className="font-bold">⚠ {t("production")}</span>}
          <span className="ml-auto">{t("mode")}: approval-first</span>
          <span>{t("model")}: gateway default</span>
          <span>{me?.workspaces[0]?.role ?? ""}</span>
        </footer>
      </section>

      {/* right: agent */}
      <aside className={`${rightOpen ? "w-full md:w-96" : "w-0"} ${rightOpen ? "absolute inset-y-0 right-0 z-30 md:static" : ""} shrink-0 overflow-hidden border-l border-border bg-panel transition-all`}>
        <AgentPanel tab={active} permissions={permissions} />
      </aside>

      <Dialog open={!!keyPrompt} onClose={() => setKeyPrompt(null)} title={keyPrompt?.mismatch ? "⚠ Host key changed" : "Unknown host key"}>
        {keyPrompt && (
          <div className="space-y-3 text-sm">
            {keyPrompt.mismatch ? (
              <p className="text-danger">The host key presented by <b>{keyPrompt.host.host}</b> does not match the trusted key. This may indicate a man-in-the-middle attack. Connection was refused and an R4 audit alert was recorded. Revoke the old key from the host page only after verifying out-of-band.</p>
            ) : (
              <p>First connection to <b>{keyPrompt.host.name}</b> ({keyPrompt.host.host}:{keyPrompt.host.port}). Verify the fingerprint out-of-band before trusting it.</p>
            )}
            <div className="mono rounded border border-border bg-panel-2 p-2 text-xs">{keyPrompt.keyType} {keyPrompt.fingerprint}</div>
            {!keyPrompt.mismatch && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setKeyPrompt(null)}>{t("close")}</Button>
                <Button onClick={() => void trustAndConnect()} disabled={!permissions.includes("hosts:manage")}>{t("trustKey")}</Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
