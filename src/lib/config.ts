/**
 * Central place for environment-derived configuration. All values are read
 * lazily so unit tests can override process.env.
 */
export function appEnv(): "development" | "test" | "production" {
  const v = process.env.APP_ENV ?? (process.env.NODE_ENV === "test" ? "test" : "development");
  return v === "production" ? "production" : v === "test" ? "test" : "development";
}

export function isProduction(): boolean {
  return appEnv() === "production";
}

export const config = {
  sessionTtlSeconds: () => Number(process.env.SESSION_TTL_SECONDS ?? 12 * 3600),
  cookieName: () => process.env.SESSION_COOKIE_NAME ?? "webssh_session",
  maxLoginFailures: () => Number(process.env.MAX_LOGIN_FAILURES ?? 5),
  lockoutMinutes: () => Number(process.env.LOCKOUT_MINUTES ?? 15),
  maxWsMessageBytes: () => Number(process.env.MAX_TERMINAL_MESSAGE_BYTES ?? 64 * 1024),
  maxSessionsPerUser: () => Number(process.env.MAX_SESSIONS_PER_USER ?? 20),
  maxSessionsPerNode: () => Number(process.env.MAX_SESSIONS_PER_NODE ?? 500),
  idleTimeoutSeconds: () => Number(process.env.TERMINAL_IDLE_TIMEOUT_SECONDS ?? 1800),
  approvalTtlSeconds: () => Number(process.env.APPROVAL_TTL_SECONDS ?? 900),
  toolOutputMaxBytes: () => Number(process.env.TOOL_OUTPUT_MAX_BYTES ?? 32 * 1024),
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  mockSshEnabled: () => (process.env.MOCK_SSH_ENABLED ?? (isProduction() ? "false" : "true")) === "true",
  mockSshPort: () => Number(process.env.MOCK_SSH_PORT ?? 2222),
  mockSshUser: () => process.env.MOCK_SSH_USER ?? "demo",
  mockSshPassword: () => process.env.MOCK_SSH_PASSWORD ?? "demo-password",
  nodeId: () => process.env.NODE_ID ?? `node-${process.pid}`,
  providerAllowPrivateHosts: () => process.env.PROVIDER_ALLOW_PRIVATE_HOSTS === "true",
  providerAllowHttp: () => process.env.PROVIDER_ALLOW_HTTP === "true" || !isProduction(),
};
