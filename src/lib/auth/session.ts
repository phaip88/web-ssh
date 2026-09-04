import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { db } from "@/db";
import { authSessions, organizationMembers, users, workspaceMembers } from "@/db/schema";
import { config, isProduction } from "@/lib/config";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
}

export interface Membership {
  orgId: string;
  orgRole: string;
  workspaces: { workspaceId: string; role: string }[];
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  memberships: Membership[];
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, ip: string | null, userAgent: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds() * 1000);
  const [row] = await db
    .insert(authSessions)
    .values({ userId, tokenHash: hashToken(token), ip, userAgent, expiresAt })
    .returning({ id: authSessions.id });
  return { token, sessionId: row.id, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(config.cookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(config.cookieName(), "", { httpOnly: true, sameSite: "lax", secure: isProduction(), path: "/", maxAge: 0 });
}

export async function revokeSession(sessionId: string) {
  await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, sessionId));
}

export async function loadMemberships(userId: string): Promise<Membership[]> {
  const orgs = await db
    .select({ orgId: organizationMembers.orgId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  const ws = await db
    .select({ orgId: workspaceMembers.orgId, workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return orgs.map((o) => ({
    orgId: o.orgId,
    orgRole: o.role,
    workspaces: ws.filter((w) => w.orgId === o.orgId).map((w) => ({ workspaceId: w.workspaceId, role: w.role })),
  }));
}

/**
 * Resolves the caller from the session cookie. Returns null when anonymous.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const jar = await cookies();
  const token = jar.get(config.cookieName())?.value;
  if (!token) return null;
  const h = await headers();
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      isPlatformAdmin: users.isPlatformAdmin,
      status: users.status,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  const memberships = await loadMemberships(row.userId);
  return {
    user: { id: row.userId, email: row.email, displayName: row.displayName, isPlatformAdmin: row.isPlatformAdmin },
    sessionId: row.sessionId,
    memberships,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip"),
    userAgent: h.get("user-agent"),
    requestId: h.get("x-request-id") ?? randomBytes(8).toString("hex"),
  };
}
