/**
 * Idempotent development seed. Creates a tenant, workspace, three users with
 * different roles, the built-in mock provider and two hosts pointing at the
 * mock SSH server. Never run against production data.
 *
 *   npx tsx scripts/seed.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { credentials, environments, modelProviders, organizationMembers, organizations, sshHosts, users, workspaceMembers, workspaces } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { encryptSecret } from "../src/lib/crypto/envelope";
import { appEnv, config } from "../src/lib/config";

async function main() {
  if (appEnv() === "production" && process.env.ALLOW_PROD_SEED !== "true") {
    throw new Error("Refusing to seed a production environment (set ALLOW_PROD_SEED=true to override)");
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe-Admin-2026";
  const devPassword = process.env.SEED_DEV_PASSWORD ?? "ChangeMe-Dev-2026";

  await db.execute(sql.raw(readFileSync(join(process.cwd(), "drizzle/sql/audit_guard.sql"), "utf8")));

  const [org] = await db.insert(organizations).values({ slug: "acme", name: "Acme Corp" }).onConflictDoUpdate({ target: organizations.slug, set: { name: "Acme Corp" } }).returning();
  const [ws] = await db.insert(workspaces).values({ orgId: org.id, slug: "platform", name: "Platform Engineering" }).onConflictDoUpdate({ target: [workspaces.orgId, workspaces.slug], set: { name: "Platform Engineering" } }).returning();

  const upsertUser = async (email: string, displayName: string, password: string, isPlatformAdmin: boolean) => {
    const [u] = await db
      .insert(users)
      .values({ email, displayName, passwordHash: await hashPassword(password), isPlatformAdmin })
      .onConflictDoUpdate({ target: users.email, set: { displayName, passwordHash: await hashPassword(password), isPlatformAdmin, status: "active", lockedUntil: null, failedLoginCount: 0 } })
      .returning();
    return u;
  };
  const admin = await upsertUser("admin@example.com", "Platform Admin", adminPassword, true);
  const dev = await upsertUser("dev@example.com", "Dana Developer", devPassword, false);
  const auditor = await upsertUser("auditor@example.com", "Audrey Auditor", devPassword, false);

  for (const [u, orgRole, wsRole] of [
    [admin, "org_owner", "workspace_admin"],
    [dev, "org_member", "developer"],
    [auditor, "org_member", "auditor"],
  ] as const) {
    await db.insert(organizationMembers).values({ orgId: org.id, userId: u.id, role: orgRole }).onConflictDoUpdate({ target: [organizationMembers.orgId, organizationMembers.userId], set: { role: orgRole } });
    await db.insert(workspaceMembers).values({ orgId: org.id, workspaceId: ws.id, userId: u.id, role: wsRole }).onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: wsRole } });
  }

  const existingEnvs = await db.select().from(environments).where(eq(environments.workspaceId, ws.id));
  if (!existingEnvs.length) {
    await db.insert(environments).values([
      { orgId: org.id, workspaceId: ws.id, name: "development", isProduction: false },
      { orgId: org.id, workspaceId: ws.id, name: "staging", isProduction: false },
      { orgId: org.id, workspaceId: ws.id, name: "production", isProduction: true },
    ]);
  }

  const existingCreds = await db.select().from(credentials).where(eq(credentials.workspaceId, ws.id));
  let cred = existingCreds.find((c) => c.name === "mock-demo-password");
  if (!cred) {
    const id = crypto.randomUUID();
    [cred] = await db.insert(credentials).values({ id, orgId: org.id, workspaceId: ws.id, name: "mock-demo-password", type: "password", encryptedSecret: encryptSecret(JSON.stringify({ password: config.mockSshPassword() }), `credential:${id}`), createdBy: admin.id }).returning();
  }

  const existingHosts = await db.select().from(sshHosts).where(eq(sshHosts.workspaceId, ws.id));
  const hostDefs = [
    { name: "mock-web-01 (dev)", environment: "development", labels: ["mock", "web", "nginx"], hostKeyPolicy: "tofu" },
    { name: "mock-web-01 (production)", environment: "production", labels: ["mock", "web", "prod"], hostKeyPolicy: "strict" },
  ];
  for (const h of hostDefs) {
    if (existingHosts.some((e) => e.name === h.name)) continue;
    await db.insert(sshHosts).values({ orgId: org.id, workspaceId: ws.id, name: h.name, host: "127.0.0.1", port: config.mockSshPort(), username: config.mockSshUser(), authType: "password", credentialId: cred.id, labels: h.labels, environment: h.environment, hostKeyPolicy: h.hostKeyPolicy, createdBy: admin.id, isFavorite: h.environment === "development" });
  }

  const providers = await db.select().from(modelProviders).where(eq(modelProviders.orgId, org.id));
  if (!providers.some((p) => p.kind === "mock")) {
    await db.insert(modelProviders).values({ orgId: org.id, name: "Built-in Mock Model", kind: "mock", defaultModel: "mock-agent-1", contextWindow: 32000, maxOutputTokens: 2048, isDefault: true });
  }

  console.log("Seed complete.");
  console.log(`  org=${org.slug} workspace=${ws.slug}`);
  console.log(`  admin@example.com / ${adminPassword}  (workspace_admin, platform admin)`);
  console.log(`  dev@example.com   / ${devPassword}  (developer)`);
  console.log(`  auditor@example.com / ${devPassword}  (auditor)`);
  console.log(`  mock ssh: 127.0.0.1:${config.mockSshPort()} user=${config.mockSshUser()}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
