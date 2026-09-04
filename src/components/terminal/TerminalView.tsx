"use client";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { useTerminalStore } from "./store";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let msgCounter = 0;
const nextId = () => `c-${Date.now().toString(36)}-${(msgCounter++).toString(36)}`;

/**
 * xterm.js view bound to one terminal session. Output arrives over SSE
 * (resumable via ?since=seq), input/resize go over POST using the same
 * protocol envelope.
 */
export function TerminalView({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const updateTab = useTerminalStore((s) => s.updateTab);

  useEffect(() => {
    if (!ref.current) return;
    const dark = document.documentElement.classList.contains("dark");
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, JetBrains Mono, Fira Code, Menlo, Consolas, monospace",
      allowProposedApi: true,
      scrollback: 5000,
      theme: dark ? { background: "#0b0f14", foreground: "#e5e7eb", cursor: "#3b82f6" } : { background: "#ffffff", foreground: "#0f172a", cursor: "#2563eb" },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(ref.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let lastSeq = 0;
    let closed = false;
    let es: EventSource | null = null;
    let retry = 0;
    const post = (body: Record<string, unknown>) =>
      fetch(`/api/terminal/sessions/${sessionId}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, id: nextId(), ts: Date.now(), sessionId, ...body }) }).catch(() => undefined);

    // Batch keystrokes within a frame so fast typing/paste does not fan out into hundreds of requests.
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending) return;
      const data = pending;
      pending = "";
      void post({ type: "terminal.input", data });
    };
    term.onData((d) => {
      pending += d;
      if (pending.length > 8192) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, 8);
    });
    term.onResize(({ cols, rows }) => void post({ type: "terminal.resize", cols, rows }));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key === "F") {
        const q = prompt("Search terminal");
        if (q) search.findNext(q);
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key === "C") {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      return true;
    });

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/terminal/sessions/${sessionId}/stream${lastSeq ? `?since=${lastSeq}` : ""}`);
      es.addEventListener("session.status", (ev) => {
        const m = JSON.parse((ev as MessageEvent).data) as { status: string; resumable: boolean; lastSeq: number };
        retry = 0;
        if (lastSeq && !m.resumable) term.writeln("\r\n\x1b[33m[reconnected – some output may have been lost]\x1b[0m");
        if (!lastSeq && m.resumable === false && m.status === "active") term.reset();
        updateTab(sessionId, { status: m.status === "active" ? "active" : m.status === "closed" ? "closed" : "connecting" });
      });
      es.addEventListener("terminal.output", (ev) => {
        const m = JSON.parse((ev as MessageEvent).data) as { seq: number; data: string };
        if (m.seq <= lastSeq) return;
        lastSeq = m.seq;
        term.write(b64ToBytes(m.data));
        updateTab(sessionId, { lastSeq });
      });
      es.addEventListener("terminal.heartbeat", (ev) => {
        const m = JSON.parse((ev as MessageEvent).data) as { ts: number };
        updateTab(sessionId, { latencyMs: Math.max(0, Date.now() - m.ts) });
      });
      es.addEventListener("terminal.closed", (ev) => {
        const m = JSON.parse((ev as MessageEvent).data) as { reason: string };
        closed = true;
        term.writeln(`\r\n\x1b[31m[session closed: ${m.reason}]\x1b[0m`);
        updateTab(sessionId, { status: "closed" });
        es?.close();
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        updateTab(sessionId, { status: "connecting" });
        const delay = Math.min(10_000, 500 * 2 ** retry++);
        setTimeout(connect, delay);
      };
    };
    connect();
    const heartbeat = setInterval(() => void post({ type: "terminal.heartbeat" }), 30_000);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(ref.current);
    return () => {
      closed = true;
      clearInterval(heartbeat);
      ro.disconnect();
      es?.close();
      term.dispose();
    };
  }, [sessionId, updateTab]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      }, 30);
    }
  }, [visible]);

  return <div ref={ref} className="h-full w-full" style={{ display: visible ? "block" : "none" }} />;
}
