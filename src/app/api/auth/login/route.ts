import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { ApiError, assertSameOrigin, handler, json, parseBody, rateLimit } from "@/lib/http";

const schema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) });

export const POST = handler(async (req) => {
  assertSameOrigin(req);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  rateLimit(`login:${ip}`, 20, 60_000);
  const { email, password } = await parseBody(req, schema);
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const ua = req.headers.get("user-agent");
  const deny = async (reason: string) => {
    await audit({ actorId: user?.id ?? null, resourceType: "auth", resourceId: email.toLowerCase(), action: "auth.login", result: "failure", riskLevel: "R1", sourceIp: ip, userAgent: ua, metadata: { reason } });
    throw new ApiError("UNAUTHENTICATED", "Invalid email or password");
  };
  if (!user || user.deletedAt || user.status === "disabled") return deny("unknown_or_disabled");
  if (user.lockedUntil && user.lockedUntil > new Date()) return deny("locked");
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    const lock = failures >= config.maxLoginFailures();
    await db.update(users).set({ failedLoginCount: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + config.lockoutMinutes() * 60_000) : null, updatedAt: new Date() }).where(eq(users.id, user.id));
    return deny(lock ? "locked_now" : "bad_password");
  }
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
  const { token, sessionId, expiresAt } = await createSession(user.id, ip, ua);
  await setSessionCookie(token, expiresAt);
  await audit({ actorId: user.id, resourceType: "auth", resourceId: user.id, action: "auth.login", result: "success", sourceIp: ip, userAgent: ua, sessionId, metadata: { mfa: user.mfaEnabled } });
  return json({ user: { id: user.id, email: user.email, displayName: user.displayName, isPlatformAdmin: user.isPlatformAdmin } });
});
