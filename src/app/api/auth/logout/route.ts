import { clearSessionCookie, revokeSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { handler, json, requireAuth } from "@/lib/http";

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  await revokeSession(ctx.sessionId);
  await clearSessionCookie();
  await audit({ actor: ctx, resourceType: "auth", resourceId: ctx.user.id, action: "auth.logout", result: "success", sessionId: ctx.sessionId });
  return json({ ok: true });
});
