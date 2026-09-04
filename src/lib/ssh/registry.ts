/**
 * In-process SSH session registry (the "terminal gateway"). Owns ssh2 client
 * connections, interactive shells, output ring buffers for reconnect replay,
 * SSE subscribers with back-pressure and the append-only recording writer.
 *
 * Multi-node deployments must route a session's traffic to the node named in
 * terminal_sessions.node_id (sticky routing) – see docs/ARCHITECTURE.md.
 */
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { terminalEvents, terminalSessions } from "@/db/schema";
import { config } from "@/lib/config";
import { envelope, sseFrame, type ServerMessage } from "@/lib/protocol/messages";
import { audit } from "@/lib/audit";

const RING_LIMIT = 256 * 1024; // bytes retained for replay
const SUBSCRIBER_HIGH_WATER = 512 * 1024; // bytes of unflushed data before we pause the SSH stream
const RECORD_FLUSH_MS = 1000;
const MAX_EVENT_CHUNK = 8 * 1024;

export interface Subscriber {
  id: string;
  write: (frame: string) => boolean; // returns false when buffer is full
  close: () => void;
  pending: number;
}

export interface LiveSession {
  id: string;
  orgId: string;
  workspaceId: string;
  hostId: string;
  userId: string;
  environment: string;
  client: Client;
  shell: ClientChannel | null;
  ring: { seq: number; data: string }[];
  ringBytes: number;
  seq: number;
  subscribers: Map<string, Subscriber>;
  startedAt: number;
  lastActivity: number;
  bytesIn: number;
  bytesOut: number;
  status: "connecting" | "active" | "closed";
  eventQueue: { seq: number; kind: string; offsetMs: number; data: string; redacted: boolean }[];
  eventSeq: number;
  flushTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  maxDurationTimer: NodeJS.Timeout | null;
  paused: boolean;
  lastOutputTail: string;
  execLock: Promise<void>;
  cols: number;
  rows: number;
}

const g = globalThis as typeof globalThis & { __sshRegistry?: Map<string, LiveSession> };
export const registry: Map<string, LiveSession> = g.__sshRegistry ?? (g.__sshRegistry = new Map());

export function countUserSessions(userId: string): number {
  let n = 0;
  for (const s of registry.values()) if (s.userId === userId && s.status !== "closed") n++;
  return n;
}

export function getLive(sessionId: string): LiveSession | undefined {
  return registry.get(sessionId);
}

export interface OpenOptions {
  sessionId: string;
  orgId: string;
  workspaceId: string;
  hostId: string;
  userId: string;
  environment: string;
  connect: ConnectConfig;
  cols: number;
  rows: number;
  maxSessionDuration: number;
  recordingEnabled: boolean;
}

export function openSession(opts: OpenOptions): Promise<LiveSession> {
  if (registry.size >= config.maxSessionsPerNode()) {
    return Promise.reject(new Error("Node session capacity reached"));
  }
  const client = new Client();
  const session: LiveSession = {
    id: opts.sessionId,
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    hostId: opts.hostId,
    userId: opts.userId,
    environment: opts.environment,
    client,
    shell: null,
    ring: [],
    ringBytes: 0,
    seq: 0,
    subscribers: new Map(),
    startedAt: Date.now(),
    lastActivity: Date.now(),
    bytesIn: 0,
    bytesOut: 0,
    status: "connecting",
    eventQueue: [],
    eventSeq: 0,
    flushTimer: null,
    idleTimer: null,
    maxDurationTimer: null,
    paused: false,
    lastOutputTail: "",
    execLock: Promise.resolve(),
    cols: opts.cols,
    rows: opts.rows,
  };
  registry.set(session.id, session);

  return new Promise<LiveSession>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      closeSession(session.id, `error: ${err.message}`);
    };
    client.on("ready", () => {
      client.shell({ term: "xterm-256color", cols: opts.cols, rows: opts.rows }, (err, stream) => {
        if (err) return fail(err);
        session.shell = stream;
        session.status = "active";
        stream.on("data", (chunk: Buffer) => onOutput(session, chunk));
        stream.stderr.on("data", (chunk: Buffer) => onOutput(session, chunk));
        stream.on("close", () => closeSession(session.id, "remote shell closed"));
        if (opts.recordingEnabled) scheduleFlush(session);
        armIdleTimer(session);
        session.maxDurationTimer = setTimeout(() => closeSession(session.id, "max session duration reached"), opts.maxSessionDuration * 1000);
        settled = true;
        resolve(session);
      });
    });
    client.on("error", (err) => fail(err));
    client.on("close", () => closeSession(session.id, "connection closed"));
    try {
      client.connect({ ...opts.connect, keepaliveCountMax: 3 });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function onOutput(session: LiveSession, chunk: Buffer) {
  session.lastActivity = Date.now();
  session.bytesOut += chunk.length;
  session.seq += 1;
  const data = chunk.toString("base64");
  session.ring.push({ seq: session.seq, data });
  session.ringBytes += data.length;
  while (session.ringBytes > RING_LIMIT && session.ring.length > 1) {
    const dropped = session.ring.shift()!;
    session.ringBytes -= dropped.data.length;
  }
  const text = chunk.toString("utf8");
  session.lastOutputTail = (session.lastOutputTail + text).slice(-4096);
  recordEvent(session, "output", data, false);
  broadcast(session, envelope(session.id, "terminal.output", { seq: session.seq, data }));
  armIdleTimer(session);
}

export function broadcast(session: LiveSession, msg: ServerMessage) {
  const frame = sseFrame(msg);
  let anyBlocked = false;
  for (const sub of session.subscribers.values()) {
    sub.pending += frame.length;
    const ok = sub.write(frame);
    if (!ok || sub.pending > SUBSCRIBER_HIGH_WATER) anyBlocked = true;
  }
  // Back-pressure: pause the SSH stream when any browser cannot keep up; resume once drained.
  if (anyBlocked && session.shell && !session.paused) {
    session.paused = true;
    session.shell.pause();
    setTimeout(() => {
      for (const sub of session.subscribers.values()) sub.pending = 0;
      session.paused = false;
      session.shell?.resume();
    }, 250);
  }
}

export function subscribe(session: LiveSession, sub: Subscriber, sinceSeq: number | null): void {
  session.subscribers.set(sub.id, sub);
  const oldest = session.ring[0]?.seq ?? session.seq + 1;
  const resumable = sinceSeq !== null && sinceSeq + 1 >= oldest;
  sub.write(
    sseFrame(
      envelope(session.id, "session.status", {
        status: session.status,
        resumable,
        lastSeq: session.seq,
        detail: { hostId: session.hostId, environment: session.environment, replayFrom: resumable ? sinceSeq : null },
      }),
    ),
  );
  if (resumable) {
    for (const item of session.ring) {
      if (item.seq > (sinceSeq as number)) sub.write(sseFrame(envelope(session.id, "terminal.output", { seq: item.seq, data: item.data })));
    }
  } else {
    // Fresh attach: replay whatever we still have so the screen is not blank.
    for (const item of session.ring) sub.write(sseFrame(envelope(session.id, "terminal.output", { seq: item.seq, data: item.data })));
  }
}

export function unsubscribe(session: LiveSession, subId: string) {
  session.subscribers.delete(subId);
}

/** Heuristic: hide input typed right after a password prompt from recordings. */
function inputLooksSensitive(session: LiveSession): boolean {
  return /(password|passphrase|token|secret)[^\n]*:\s*$/i.test(session.lastOutputTail.slice(-200));
}

export function writeInput(session: LiveSession, data: string, kind: "input" | "ai_exec" = "input") {
  if (!session.shell || session.status !== "active") throw new Error("Session is not active");
  const buf = Buffer.from(data, "utf8");
  if (buf.length > config.maxWsMessageBytes()) throw new Error("Input exceeds maximum message size");
  session.bytesIn += buf.length;
  session.lastActivity = Date.now();
  const sensitive = inputLooksSensitive(session);
  recordEvent(session, kind, sensitive ? "" : data, sensitive);
  session.shell.write(buf);
  armIdleTimer(session);
}

export function resize(session: LiveSession, cols: number, rows: number) {
  session.cols = cols;
  session.rows = rows;
  session.shell?.setWindow(rows, cols, 0, 0);
  recordEvent(session, "resize", JSON.stringify({ cols, rows }), false);
}

export function sendSignal(session: LiveSession, signal: "INT" | "TERM" | "KILL" | "HUP" | "EOF") {
  if (!session.shell) return;
  if (signal === "EOF") session.shell.end();
  else if (signal === "INT") session.shell.write("\x03");
  else session.shell.signal(signal);
}

export function recordEvent(session: LiveSession, kind: string, data: string, redacted: boolean) {
  session.eventSeq += 1;
  for (let i = 0; i < Math.max(1, Math.ceil(data.length / MAX_EVENT_CHUNK)); i++) {
    session.eventQueue.push({
      seq: session.eventSeq,
      kind,
      offsetMs: Date.now() - session.startedAt,
      data: data.slice(i * MAX_EVENT_CHUNK, (i + 1) * MAX_EVENT_CHUNK),
      redacted,
    });
  }
}

function scheduleFlush(session: LiveSession) {
  session.flushTimer = setInterval(() => void flushEvents(session), RECORD_FLUSH_MS);
}

async function flushEvents(session: LiveSession) {
  if (!session.eventQueue.length) return;
  const batch = session.eventQueue.splice(0, 500);
  try {
    await db.insert(terminalEvents).values(batch.map((e) => ({ ...e, orgId: session.orgId, sessionId: session.id })));
  } catch (err) {
    console.error("[recording] flush failed", String(err));
  }
}

function armIdleTimer(session: LiveSession) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => closeSession(session.id, "idle timeout"), config.idleTimeoutSeconds() * 1000);
}

export async function closeSession(sessionId: string, reason: string) {
  const session = registry.get(sessionId);
  if (!session || session.status === "closed") return;
  // A session that never reached "active" failed to connect; the caller records
  // the failure (with host-key details) so we only tear down resources here.
  const neverActive = session.status === "connecting";
  session.status = "closed";
  if (session.flushTimer) clearInterval(session.flushTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
  try {
    session.shell?.end();
    session.client.end();
  } catch {
    /* ignore */
  }
  broadcast(session, envelope(session.id, "terminal.closed", { reason }));
  for (const sub of session.subscribers.values()) sub.close();
  session.subscribers.clear();
  registry.delete(sessionId);
  if (neverActive) return;
  await flushEvents(session);
  await db
    .update(terminalSessions)
    .set({ status: "closed", closeReason: reason, endedAt: new Date(), bytesIn: session.bytesIn, bytesOut: session.bytesOut, updatedAt: new Date() })
    .where(eq(terminalSessions.id, sessionId));
  await audit({
    actorId: session.userId,
    tenantId: session.orgId,
    workspaceId: session.workspaceId,
    resourceType: "terminal_session",
    resourceId: sessionId,
    action: "terminal.session.closed",
    result: "success",
    sessionId,
    metadata: { reason, bytesIn: session.bytesIn, bytesOut: session.bytesOut, durationMs: Date.now() - session.startedAt },
  });
}

/**
 * Runs a single non-interactive command on the session's connection using a
 * dedicated exec channel, so agent tools never type into the user's shell.
 */
export function execOnSession(
  session: LiveSession,
  command: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean; durationMs: number }> {
  const run = () =>
    new Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean; durationMs: number }>((resolve, reject) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`Command timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      session.client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          done = true;
          return reject(err);
        }
        const append = (target: "stdout" | "stderr", chunk: Buffer) => {
          const cur = target === "stdout" ? stdout : stderr;
          if (cur.length >= opts.maxBytes) {
            truncated = true;
            return;
          }
          const next = cur + chunk.toString("utf8");
          if (target === "stdout") stdout = next.slice(0, opts.maxBytes);
          else stderr = next.slice(0, opts.maxBytes);
          if (next.length > opts.maxBytes) truncated = true;
        };
        stream.on("data", (c: Buffer) => append("stdout", c));
        stream.stderr.on("data", (c: Buffer) => append("stderr", c));
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (done) return;
          done = true;
          resolve({ stdout, stderr, exitCode: code ?? null, truncated, durationMs: Date.now() - started });
        });
      });
    });
  // Serialise exec calls per session to keep tool outputs attributable.
  const p = session.execLock.then(run, run);
  session.execLock = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

export function nodeStats() {
  return {
    nodeId: config.nodeId(),
    activeSessions: registry.size,
    subscribers: [...registry.values()].reduce((n, s) => n + s.subscribers.size, 0),
  };
}

export async function markSessionActive(sessionId: string) {
  await db.update(terminalSessions).set({ status: "active", nodeId: config.nodeId(), updatedAt: sql`now()` }).where(eq(terminalSessions.id, sessionId));
}
