import { describe, expect, it } from "vitest";
import { redactObject, redactSecrets, maskTail } from "@/lib/security/redact";
import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { hasPermission, permissionsFor } from "@/lib/auth/rbac";
import type { AuthContext } from "@/lib/auth/session";
import { clientMessageSchema } from "@/lib/protocol/messages";
import { isPrivateAddress, assertSafeUrl, SsrfViolation } from "@/lib/llm/ssrf-guard";
import { hashPassword, verifyPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { computeHash } from "@/lib/audit";

describe("secret redaction", () => {
  it("masks common credential formats", () => {
    const r = redactSecrets("key sk-abcdefghijklmnopqrstuvwxyz1234 and AKIAABCDEFGHIJKLMNOP password=hunter2secret");
    expect(r.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(r.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(r.text).not.toContain("hunter2secret");
    expect(r.findings).toEqual(expect.arrayContaining(["openai_key", "aws_access_key", "kv_secret"]));
  });
  it("masks private keys and URL credentials", () => {
    const r = redactSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\npostgres://user:pa55@db/app");
    expect(r.text).toContain("[REDACTED:private_key]");
    expect(r.text).toContain("postgres://user:[REDACTED]@db/app");
  });
  it("redacts by key name in objects", () => {
    const o = redactObject({ apiKey: "abc", nested: { password: "x", ok: "keep" } });
    expect(o.apiKey).toBe("[REDACTED]");
    expect(o.nested.password).toBe("[REDACTED]");
    expect(o.nested.ok).toBe("keep");
  });
  it("maskTail keeps only the tail", () => {
    expect(maskTail("sk-1234567890abcdef")).toMatch(/\*+cdef$/);
  });
});

describe("envelope encryption", () => {
  it("round-trips and binds AAD", () => {
    const p = encryptSecret("s3cret", "credential:1");
    expect(decryptSecret(p, "credential:1")).toBe("s3cret");
    expect(() => decryptSecret(p, "credential:2")).toThrow();
    expect(JSON.stringify(p)).not.toContain("s3cret");
  });
});

describe("password hashing", () => {
  it("verifies and rejects", async () => {
    const h = await hashPassword("Correct-Horse-Battery-9");
    expect(await verifyPassword("Correct-Horse-Battery-9", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(validatePasswordPolicy("short")).toBeTruthy();
    expect(validatePasswordPolicy("LongEnoughPassw0rd")).toBeNull();
  });
});

function ctx(role: string, isPlatformAdmin = false): AuthContext {
  return { user: { id: "u", email: "u@x", displayName: "u", isPlatformAdmin }, sessionId: "s", memberships: [{ orgId: "org", orgRole: "org_member", workspaces: [{ workspaceId: "ws", role }] }], ip: null, userAgent: null, requestId: "r" };
}

describe("RBAC/ABAC", () => {
  const scope = { orgId: "org", workspaceId: "ws" };
  it("viewer cannot connect; developer can", () => {
    expect(hasPermission(ctx("viewer"), scope, "hosts:connect")).toBe(false);
    expect(hasPermission(ctx("developer"), scope, "hosts:connect")).toBe(true);
  });
  it("developer is blocked from production hosts via ABAC", () => {
    expect(hasPermission(ctx("developer"), scope, "hosts:connect", { environment: "production" })).toBe(false);
    expect(hasPermission(ctx("operator"), scope, "hosts:connect", { environment: "production" })).toBe(true);
  });
  it("cross-tenant scope yields no permissions", () => {
    expect(permissionsFor(ctx("workspace_admin"), { orgId: "other", workspaceId: "ws" }).size).toBe(0);
  });
  it("auditor can read audit but not execute", () => {
    expect(hasPermission(ctx("auditor"), scope, "audit:read")).toBe(true);
    expect(hasPermission(ctx("auditor"), scope, "terminal:execute")).toBe(false);
  });
  it("R4 is never auto-executable", () => {
    expect(hasPermission(ctx("workspace_admin"), scope, "agent:auto", { riskLevel: "R4" })).toBe(false);
  });
});

describe("protocol schema", () => {
  const base = { v: 1, id: "m1", ts: Date.now(), sessionId: "00000000-0000-4000-8000-000000000000" };
  it("accepts valid input and rejects oversized/unknown", () => {
    expect(clientMessageSchema.safeParse({ ...base, type: "terminal.input", data: "ls\n" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, type: "terminal.resize", cols: 100, rows: 30 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, type: "terminal.input", data: "x".repeat(70_000) }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, type: "terminal.exec", data: "rm" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, v: 2, type: "terminal.heartbeat" }).success).toBe(false);
  });
});

describe("SSRF guard", () => {
  it("classifies private ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
  it("rejects metadata, localhost, credentials and bad schemes", async () => {
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data", { allowPrivate: false, allowHttp: true })).rejects.toBeInstanceOf(SsrfViolation);
    await expect(assertSafeUrl("http://localhost:11434/v1", { allowPrivate: false, allowHttp: true })).rejects.toBeInstanceOf(SsrfViolation);
    await expect(assertSafeUrl("http://metadata.google.internal/", { allowPrivate: false, allowHttp: true })).rejects.toBeInstanceOf(SsrfViolation);
    await expect(assertSafeUrl("ftp://example.com/", {})).rejects.toBeInstanceOf(SsrfViolation);
    await expect(assertSafeUrl("https://user:pw@example.com/", {})).rejects.toBeInstanceOf(SsrfViolation);
    await expect(assertSafeUrl("http://api.example.com/", { allowHttp: false })).rejects.toBeInstanceOf(SsrfViolation);
  });
  it("allows allowlisted private hosts (admin opt-in) but never the cloud metadata IP", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:11434/v1", { allowPrivate: true, allowHttp: true })).resolves.toBeTruthy();
    await expect(assertSafeUrl("http://169.254.169.254/", { allowPrivate: true, allowHttp: true })).rejects.toBeInstanceOf(SsrfViolation);
  });
});

describe("audit hash chain", () => {
  it("is deterministic and order sensitive", () => {
    const a = computeHash(null, { action: "x", n: 1 });
    expect(computeHash(null, { n: 1, action: "x" })).toBe(a);
    expect(computeHash(a, { action: "y" })).not.toBe(computeHash(null, { action: "y" }));
  });
});
