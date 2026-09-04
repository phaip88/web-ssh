/**
 * Runs once per server process. Starts the mock SSH server in non-production
 * environments and validates security-critical configuration in production.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isProduction } = await import("@/lib/config");
  if (isProduction()) {
    const missing = ["APP_MASTER_KEY", "DATABASE_URL"].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Refusing to start in production without: ${missing.join(", ")}`);
  }
  const { startMockSshServer } = await import("@/lib/mock-ssh/server");
  startMockSshServer();
}
