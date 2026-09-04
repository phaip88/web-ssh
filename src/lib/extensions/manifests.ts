/**
 * Schemas for Skill manifests, MCP server configs and plugin manifests.
 * Installation endpoints validate against these before anything is persisted;
 * the runtime sandboxes (container/worker isolation) are tracked as follow-up
 * work in README "Remaining work" – nothing here executes code.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "must be semver");
const permission = z.enum(["terminal:execute", "terminal:read", "filesystem:read", "filesystem:write", "process:list", "service:status", "container:list", "kubernetes:get", "logs:search", "network:egress", "artifact:create"]);

export const skillManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, "reverse-DNS id required"),
    name: z.string().min(1).max(100),
    version: semver,
    description: z.string().max(2000),
    author: z.string().max(200),
    license: z.string().max(100),
    entrypoint: z.string().regex(/^[A-Za-z0-9_./-]+$/).refine((p) => !p.includes("..") && !p.startsWith("/"), "entrypoint must be relative"),
    compatibleRuntime: z.string().min(1),
    permissions: z.array(permission).max(20),
    tools: z.array(z.object({ name: z.string().regex(/^[a-z0-9_.-]+$/), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), risk: z.enum(["R0", "R1", "R2", "R3", "R4"]).default("R2"), requiresApproval: z.boolean().default(true) })).max(50).default([]),
    prompts: z.array(z.object({ name: z.string(), template: z.string().max(20_000) })).default([]),
    workflows: z.array(z.string()).default([]),
    dependencies: z.record(z.string(), semver).default({}),
    environmentSchema: z.record(z.string(), z.unknown()).default({}),
    configSchema: z.record(z.string(), z.unknown()).default({}),
    secretsSchema: z.record(z.string(), z.unknown()).default({}),
    networkPolicy: z.object({ egress: z.enum(["none", "allowlist", "any"]).default("none"), allow: z.array(z.string()).default([]) }).default({ egress: "none", allow: [] }),
    filesystemPolicy: z.object({ readOnly: z.boolean().default(true), paths: z.array(z.string()).default([]) }).default({ readOnly: true, paths: [] }),
    signature: z.string().optional(),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // A skill that never declares filesystem:write must not request writable mounts.
    if (!m.filesystemPolicy.readOnly && !m.permissions.includes("filesystem:write")) ctx.addIssue({ code: "custom", message: "writable filesystem requires filesystem:write permission", path: ["filesystemPolicy"] });
    if (m.networkPolicy.egress !== "none" && !m.permissions.includes("network:egress")) ctx.addIssue({ code: "custom", message: "network egress requires network:egress permission", path: ["networkPolicy"] });
    for (const t of m.tools) if (t.risk === "R4" && !t.requiresApproval) ctx.addIssue({ code: "custom", message: `tool ${t.name}: R4 tools must require approval`, path: ["tools"] });
  });
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export function skillChecksum(manifestText: string): string {
  return `sha256:${createHash("sha256").update(manifestText).digest("hex")}`;
}

const secretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+$/, "must reference a stored secret (secret://<id>)");

export const mcpServerConfigSchema = z
  .object({
    name: z.string().min(1).max(100),
    transport: z.enum(["stdio", "sse", "streamable_http"]),
    command: z.string().regex(/^[A-Za-z0-9_./-]+$/).optional(),
    args: z.array(z.string().max(500)).max(64).default([]),
    envSecretRefs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), secretRef).default({}),
    url: z.string().url().optional(),
    headersSecretRefs: z.record(z.string(), secretRef).default({}),
    timeout: z.number().int().min(1000).max(300_000).default(30_000),
    workspaceScope: z.string().uuid().optional(),
    allowedTools: z.array(z.string()).default([]),
    deniedTools: z.array(z.string()).default([]),
    networkPolicy: z.object({ egress: z.enum(["none", "allowlist", "any"]).default("none"), allow: z.array(z.string()).default([]) }).default({ egress: "none", allow: [] }),
    resourceLimits: z.object({ cpu: z.string().default("500m"), memory: z.string().default("256Mi"), pids: z.number().int().max(512).default(64) }).default({ cpu: "500m", memory: "256Mi", pids: 64 }),
    autoStart: z.boolean().default(false),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.transport === "stdio" && !c.command) ctx.addIssue({ code: "custom", message: "stdio transport requires command", path: ["command"] });
    if (c.transport !== "stdio" && !c.url) ctx.addIssue({ code: "custom", message: "remote transport requires url", path: ["url"] });
    if (c.transport === "stdio" && c.command && /(^|\/)(sh|bash|zsh|cmd|powershell)(\.exe)?$/.test(c.command)) ctx.addIssue({ code: "custom", message: "shell interpreters are not allowed as MCP commands", path: ["command"] });
    if (c.args.some((a) => /[;&|`$]/.test(a))) ctx.addIssue({ code: "custom", message: "shell metacharacters are not allowed in args", path: ["args"] });
  });
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
    name: z.string().min(1),
    version: semver,
    type: z.enum(["ui", "integration", "agent_tool", "auth", "notification", "secret", "llm"]),
    sdkVersion: z.string().regex(/^\^?1\.\d+\.\d+$/),
    capabilities: z.array(z.string()).max(50),
    permissions: z.array(z.string()).max(50),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    signature: z.string().min(1),
    entry: z.string().refine((p) => !p.includes(".."), "no traversal"),
    quota: z.object({ callsPerMinute: z.number().int().min(1).max(10_000).default(60) }).default({ callsPerMinute: 60 }),
  })
  .strict()
  .superRefine((p, ctx) => {
    // UI plugins must never be granted credential or provider secret scopes.
    if (p.type === "ui" && p.permissions.some((x) => /credential|provider|secret/.test(x))) ctx.addIssue({ code: "custom", message: "ui plugins cannot access credentials or provider secrets", path: ["permissions"] });
  });
