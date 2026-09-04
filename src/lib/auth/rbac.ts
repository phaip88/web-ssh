/**
 * RBAC + ABAC policy engine. Roles map to coarse permissions; `authorize`
 * additionally evaluates attribute conditions (environment, risk level).
 */
import type { AuthContext } from "./session";

export type Permission =
  | "hosts:read"
  | "hosts:manage"
  | "hosts:connect"
  | "credentials:use"
  | "credentials:manage"
  | "terminal:execute"
  | "files:transfer"
  | "agent:use"
  | "agent:auto"
  | "approvals:decide"
  | "skills:install"
  | "mcp:install"
  | "plugins:install"
  | "providers:manage"
  | "audit:read"
  | "recordings:read"
  | "env:production"
  | "batch:execute"
  | "forwarding:use"
  | "members:manage"
  | "sessions:read_all";

export type Role =
  | "platform_admin"
  | "org_owner"
  | "workspace_admin"
  | "operator"
  | "developer"
  | "auditor"
  | "viewer";

const ALL: Permission[] = [
  "hosts:read",
  "hosts:manage",
  "hosts:connect",
  "credentials:use",
  "credentials:manage",
  "terminal:execute",
  "files:transfer",
  "agent:use",
  "agent:auto",
  "approvals:decide",
  "skills:install",
  "mcp:install",
  "plugins:install",
  "providers:manage",
  "audit:read",
  "recordings:read",
  "env:production",
  "batch:execute",
  "forwarding:use",
  "members:manage",
  "sessions:read_all",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: ALL,
  org_owner: ALL,
  workspace_admin: ALL,
  operator: [
    "hosts:read",
    "hosts:manage",
    "hosts:connect",
    "credentials:use",
    "credentials:manage",
    "terminal:execute",
    "files:transfer",
    "agent:use",
    "approvals:decide",
    "env:production",
    "batch:execute",
    "recordings:read",
  ],
  developer: [
    "hosts:read",
    "hosts:connect",
    "credentials:use",
    "terminal:execute",
    "files:transfer",
    "agent:use",
    "approvals:decide",
  ],
  auditor: ["hosts:read", "audit:read", "recordings:read", "sessions:read_all"],
  viewer: ["hosts:read"],
};

export interface AuthzScope {
  orgId: string;
  workspaceId?: string;
}

export interface AuthzAttributes {
  environment?: string;
  riskLevel?: "R0" | "R1" | "R2" | "R3" | "R4";
}

export function rolesFor(ctx: AuthContext, scope: AuthzScope): Role[] {
  const roles: Role[] = [];
  if (ctx.user.isPlatformAdmin) roles.push("platform_admin");
  const m = ctx.memberships.find((x) => x.orgId === scope.orgId);
  if (!m) return roles;
  if (m.orgRole === "org_owner") roles.push("org_owner");
  if (scope.workspaceId) {
    const w = m.workspaces.find((x) => x.workspaceId === scope.workspaceId);
    if (w && isRole(w.role)) roles.push(w.role);
  }
  return roles;
}

function isRole(r: string): r is Role {
  return r in ROLE_PERMISSIONS;
}

export function permissionsFor(ctx: AuthContext, scope: AuthzScope): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of rolesFor(ctx, scope)) for (const p of ROLE_PERMISSIONS[r]) set.add(p);
  return set;
}

export function hasPermission(ctx: AuthContext, scope: AuthzScope, perm: Permission, attrs: AuthzAttributes = {}) {
  const perms = permissionsFor(ctx, scope);
  if (!perms.has(perm)) return false;
  // ABAC: production hosts require an explicit production grant on top of the base permission.
  if (attrs.environment === "production" && !perms.has("env:production")) return false;
  // ABAC: R4 actions are never auto-approved for anyone below workspace_admin.
  if (attrs.riskLevel === "R4" && perm === "agent:auto") return false;
  return true;
}

export class ForbiddenError extends Error {
  code = "FORBIDDEN" as const;
  constructor(public readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
  }
}

export function authorize(ctx: AuthContext, scope: AuthzScope, perm: Permission, attrs: AuthzAttributes = {}) {
  if (!hasPermission(ctx, scope, perm, attrs)) throw new ForbiddenError(perm);
}

export function isMemberOfOrg(ctx: AuthContext, orgId: string) {
  return ctx.user.isPlatformAdmin || ctx.memberships.some((m) => m.orgId === orgId);
}
