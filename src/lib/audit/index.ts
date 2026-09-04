/**
 * Tamper-evident audit log. Each row stores the hash of the previous row for
 * the same tenant, forming a chain that `verifyChain` can validate. Writes are
 * serialised per tenant with a PostgreSQL advisory lock so the chain never forks.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { redactObject } from "@/lib/security/redact";
import type { AuthContext } from "@/lib/auth/session";

export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export interface AuditInput {
  actor?: Pick<AuthContext, "user" | "ip" | "userAgent" | "requestId"> | null;
  actorId?: string | null;
  tenantId?: string | null;
  workspaceId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  action: string;
  result: "success" | "failure" | "denied";
  riskLevel?: RiskLevel;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  sourceIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

function canonical(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function computeHash(previousHash: string | null, body: Record<string, unknown>): string {
  return createHash("sha256")
    .update(previousHash ?? "GENESIS")
    .update("\n")
    .update(canonical(body))
    .digest("hex");
}

function lockKey(tenantId: string | null): number {
  if (!tenantId) return 0;
  return Number.parseInt(createHash("sha1").update(tenantId).digest("hex").slice(0, 7), 16);
}

export async function audit(input: AuditInput): Promise<void> {
  const tenantId = input.tenantId ?? null;
  const metadata = redactObject(input.metadata ?? {});
  const timestamp = new Date();
  const row = {
    timestamp,
    actorId: input.actorId ?? input.actor?.user.id ?? null,
    tenantId,
    workspaceId: input.workspaceId ?? null,
    sourceIp: input.sourceIp ?? input.actor?.ip ?? null,
    userAgent: input.userAgent ?? input.actor?.userAgent ?? null,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    action: input.action,
    result: input.result,
    riskLevel: input.riskLevel ?? "R0",
    requestId: input.requestId ?? input.actor?.requestId ?? null,
    sessionId: input.sessionId ?? null,
    metadata,
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(tenantId)})`);
      const prev = await tx
        .select({ integrityHash: auditEvents.integrityHash })
        .from(auditEvents)
        .where(tenantId ? eq(auditEvents.tenantId, tenantId) : sql`${auditEvents.tenantId} IS NULL`)
        .orderBy(desc(auditEvents.seq))
        .limit(1);
      const previousHash = prev[0]?.integrityHash ?? null;
      const integrityHash = computeHash(previousHash, { ...row, timestamp: timestamp.toISOString() });
      await tx.insert(auditEvents).values({ ...row, previousHash, integrityHash });
    });
  } catch (err) {
    // Audit failures must be loud but must not take the request path down.
    console.error("[audit] failed to write event", { action: input.action, err: String(err) });
  }
}

export async function verifyChain(tenantId: string, limit = 1000): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId)))
    .orderBy(auditEvents.seq)
    .limit(limit);
  let prev: string | null = null;
  for (const r of rows) {
    const expected = computeHash(prev, {
      timestamp: r.timestamp.toISOString(),
      actorId: r.actorId,
      tenantId: r.tenantId,
      workspaceId: r.workspaceId,
      sourceIp: r.sourceIp,
      userAgent: r.userAgent,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      action: r.action,
      result: r.result,
      riskLevel: r.riskLevel,
      requestId: r.requestId,
      sessionId: r.sessionId,
      metadata: r.metadata,
    });
    if (expected !== r.integrityHash || r.previousHash !== prev) return { ok: false, checked: rows.length, brokenAt: r.seq };
    prev = r.integrityHash;
  }
  return { ok: true, checked: rows.length };
}
