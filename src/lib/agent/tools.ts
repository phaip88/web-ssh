/**
 * Agent Tool Registry. Every capability the model may invoke is declared here
 * with a JSON Schema, risk level, approval requirement, production policy,
 * timeout and output limits. The runtime refuses any tool not in this registry.
 */
import { z } from "zod";
import type { RiskLevel } from "@/lib/policy/command-policy";
import { config } from "@/lib/config";
import { execOnSession, type LiveSession } from "@/lib/ssh/registry";
import { redactSecrets } from "@/lib/security/redact";
import type { Permission } from "@/lib/auth/rbac";

export interface ToolExecContext {
  session: LiveSession;
  environment: string;
}

export interface ToolSpec<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  permission: Permission;
  risk: RiskLevel;
  requiresApproval: boolean;
  allowedInProduction: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  auditFields: string[];
  /** For command-based tools: the shell command that will be policy-checked and executed. */
  toCommand?: (input: I) => string;
  execute: (input: I, ctx: ToolExecContext) => Promise<Record<string, unknown>>;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const safePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith("/") || p.startsWith("~"), "Path must be absolute")
  .refine((p) => !p.split("/").includes(".."), "Path traversal is not allowed")
  .refine((p) => !/[\x00-\x1f]/.test(p), "Control characters are not allowed");

async function runCommand(command: string, ctx: ToolExecContext, timeoutMs: number, maxBytes: number) {
  const r = await execOnSession(ctx.session, command, { timeoutMs, maxBytes });
  return {
    command,
    exitCode: r.exitCode,
    stdout: redactSecrets(r.stdout).text,
    stderr: redactSecrets(r.stderr).text,
    truncated: r.truncated,
    durationMs: r.durationMs,
  };
}

const execOutput = {
  type: "object",
  properties: { command: { type: "string" }, exitCode: { type: ["integer", "null"] }, stdout: { type: "string" }, stderr: { type: "string" }, truncated: { type: "boolean" }, durationMs: { type: "integer" } },
  required: ["command", "exitCode", "stdout", "stderr", "truncated", "durationMs"],
};

function commandTool<I>(spec: Omit<ToolSpec<I>, "execute" | "outputSchema"> & { toCommand: (input: I) => string }): ToolSpec<I> {
  return {
    ...spec,
    outputSchema: execOutput,
    execute: (input, ctx) => runCommand(spec.toCommand(input), ctx, spec.timeoutMs, spec.maxOutputBytes),
  };
}

const terminalExecute = commandTool<{ command: string; reason?: string; timeoutSeconds?: number }>({
  name: "terminal.execute",
  description: "Run a single shell command on the currently connected host and return stdout/stderr/exit code. Prefer read-only commands. Never chain destructive operations.",
  input: z.object({ command: z.string().min(1).max(4000), reason: z.string().max(500).optional(), timeoutSeconds: z.number().int().min(1).max(120).optional() }),
  inputSchema: { type: "object", properties: { command: { type: "string", description: "The exact shell command" }, reason: { type: "string", description: "Why this command is needed" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, required: ["command"] },
  permission: "terminal:execute",
  risk: "R2",
  requiresApproval: true,
  allowedInProduction: true,
  timeoutMs: 30_000,
  maxOutputBytes: config.toolOutputMaxBytes(),
  auditFields: ["command", "reason"],
  toCommand: (i) => i.command,
});

const terminalRead: ToolSpec<{ lines?: number }> = {
  name: "terminal.read",
  description: "Read the most recent output shown in the user's interactive terminal (already redacted).",
  input: z.object({ lines: z.number().int().min(1).max(200).optional() }),
  inputSchema: { type: "object", properties: { lines: { type: "integer", minimum: 1, maximum: 200 } } },
  outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  permission: "agent:use",
  risk: "R0",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 1000,
  maxOutputBytes: 16 * 1024,
  auditFields: ["lines"],
  execute: async (input, ctx) => {
    const cleaned = ctx.session.lastOutputTail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const lines = cleaned.split(/\r?\n/).slice(-(input.lines ?? 60));
    return { text: redactSecrets(lines.join("\n")).text };
  },
};

const hostInspect = commandTool<Record<string, never>>({
  name: "host.inspect",
  description: "Collect basic host facts: kernel, uptime, load, memory and disk usage.",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {} },
  permission: "agent:use",
  risk: "R0",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 16 * 1024,
  auditFields: [],
  toCommand: () => "uname -a; uptime; free -m; df -h",
});

const processList = commandTool<{ sortBy?: "cpu" | "mem"; limit?: number }>({
  name: "process.list",
  description: "List top processes sorted by CPU or memory.",
  input: z.object({ sortBy: z.enum(["cpu", "mem"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
  inputSchema: { type: "object", properties: { sortBy: { type: "string", enum: ["cpu", "mem"] }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 32 * 1024,
  auditFields: ["sortBy", "limit"],
  toCommand: (i) => `ps aux --sort=-%${i.sortBy === "mem" ? "mem" : "cpu"} | head -n ${(i.limit ?? 20) + 1}`,
});

const serviceStatus = commandTool<{ name: string }>({
  name: "service.status",
  description: "Show systemd status for a unit (read-only).",
  input: z.object({ name: z.string().regex(/^[A-Za-z0-9_.@-]{1,64}$/) }),
  inputSchema: { type: "object", properties: { name: { type: "string", pattern: "^[A-Za-z0-9_.@-]{1,64}$" } }, required: ["name"] },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 32 * 1024,
  auditFields: ["name"],
  toCommand: (i) => `systemctl status ${shq(i.name)} --no-pager`,
});

const fsList = commandTool<{ path: string }>({
  name: "filesystem.list",
  description: "List a directory (ls -la).",
  input: z.object({ path: safePath }),
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  auditFields: ["path"],
  toCommand: (i) => `ls -la ${shq(i.path)}`,
});

const fsRead = commandTool<{ path: string; maxLines?: number }>({
  name: "filesystem.read",
  description: "Read a text file (first N lines). Secrets are redacted before being returned.",
  input: z.object({ path: safePath, maxLines: z.number().int().min(1).max(2000).optional() }),
  inputSchema: { type: "object", properties: { path: { type: "string" }, maxLines: { type: "integer", minimum: 1, maximum: 2000 } }, required: ["path"] },
  permission: "files:transfer",
  risk: "R1",
  requiresApproval: true,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  auditFields: ["path", "maxLines"],
  toCommand: (i) => `head -n ${i.maxLines ?? 400} ${shq(i.path)}`,
});

const fsStat = commandTool<{ path: string }>({
  name: "filesystem.stat",
  description: "Show file metadata (stat).",
  input: z.object({ path: safePath }),
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 10_000,
  maxOutputBytes: 8 * 1024,
  auditFields: ["path"],
  toCommand: (i) => `stat ${shq(i.path)}`,
});

const containerList = commandTool<Record<string, never>>({
  name: "container.list",
  description: "List Docker containers including stopped ones.",
  input: z.object({}).strict(),
  inputSchema: { type: "object", properties: {} },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 15_000,
  maxOutputBytes: 32 * 1024,
  auditFields: [],
  toCommand: () => "docker ps -a",
});

const k8sGet = commandTool<{ resource: string; namespace?: string }>({
  name: "kubernetes.get",
  description: "kubectl get <resource> (read-only).",
  input: z.object({ resource: z.string().regex(/^[a-z0-9.-]{1,64}$/), namespace: z.string().regex(/^[a-z0-9-]{1,63}$/).optional() }),
  inputSchema: { type: "object", properties: { resource: { type: "string" }, namespace: { type: "string" } }, required: ["resource"] },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 20_000,
  maxOutputBytes: 64 * 1024,
  auditFields: ["resource", "namespace"],
  toCommand: (i) => `kubectl get ${shq(i.resource)}${i.namespace ? ` -n ${shq(i.namespace)}` : " -A"}`,
});

const logsSearch = commandTool<{ path: string; pattern: string; maxLines?: number }>({
  name: "logs.search",
  description: "grep a log file for a pattern and return matching lines.",
  input: z.object({ path: safePath, pattern: z.string().min(1).max(200), maxLines: z.number().int().min(1).max(500).optional() }),
  inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, maxLines: { type: "integer" } }, required: ["path", "pattern"] },
  permission: "agent:use",
  risk: "R1",
  requiresApproval: false,
  allowedInProduction: true,
  timeoutMs: 20_000,
  maxOutputBytes: 64 * 1024,
  auditFields: ["path", "pattern"],
  toCommand: (i) => `grep -n -E ${shq(i.pattern)} ${shq(i.path)} | tail -n ${i.maxLines ?? 100}`,
});

// Heterogeneous input types are erased at the registry boundary; each tool re-validates with its own zod schema.
const TOOLS: ToolSpec[] = [terminalExecute, terminalRead, hostInspect, processList, serviceStatus, fsList, fsRead, fsStat, containerList, k8sGet, logsSearch] as unknown as ToolSpec[];

export const toolRegistry = {
  list(): ToolSpec[] {
    return TOOLS;
  },
  get(name: string): ToolSpec | undefined {
    return TOOLS.find((t) => t.name === name);
  },
  definitions() {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  },
  describe() {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      permission: t.permission,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
      allowedInProduction: t.allowedInProduction,
      timeoutMs: t.timeoutMs,
      maxOutputBytes: t.maxOutputBytes,
      auditFields: t.auditFields,
    }));
  },
};
