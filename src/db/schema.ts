/**
 * Core data model. Every tenant-scoped table carries `orgId` (tenant) and, where
 * relevant, `workspaceId`, so isolation can be enforced both in application
 * queries and (optionally) via PostgreSQL Row Level Security.
 *
 * Sensitive material (passwords, private keys, API keys) is never stored in
 * plain columns – see `credentials.encryptedSecret` and `lib/crypto/envelope.ts`.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
const softDelete = {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};
const optimistic = {
  version: integer("version").notNull().default(1),
};

// ---------------------------------------------------------------- identity
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    status: text("status").notNull().default("active"), // active|locked|disabled
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    preferences: jsonb("preferences").notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull().references(() => users.id),
    provider: text("provider").notNull(), // local|oidc|saml|ldap
    providerSubject: text("provider_subject").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("identities_provider_subject_uq").on(t.provider, t.providerSubject)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("auth_sessions_token_uq").on(t.tokenHash), index("auth_sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- tenancy
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull().default({}),
  ...timestamps,
  ...softDelete,
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // org_owner|org_member
    ...timestamps,
  },
  (t) => [uniqueIndex("org_members_uq").on(t.orgId, t.userId)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    settings: jsonb("settings").notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("workspaces_org_slug_uq").on(t.orgId, t.slug)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // workspace_admin|operator|developer|auditor|viewer
    ...timestamps,
  },
  (t) => [uniqueIndex("ws_members_uq").on(t.workspaceId, t.userId), index("ws_members_user_idx").on(t.userId)],
);

export const roleBindings = pgTable(
  "role_bindings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    subjectType: text("subject_type").notNull(), // user|group
    subjectId: uuid("subject_id").notNull(),
    role: text("role").notNull(),
    conditions: jsonb("conditions").notNull().default({}), // ABAC conditions
    ...timestamps,
  },
  (t) => [index("role_bindings_subject_idx").on(t.subjectId)],
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
  ...softDelete,
});

export const environments = pgTable("environments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(), // development|staging|production
  isProduction: boolean("is_production").notNull().default(false),
  ...timestamps,
});

export const hostGroups = pgTable("host_groups", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  parentId: uuid("parent_id"),
  ...timestamps,
  ...softDelete,
});

// ---------------------------------------------------------------- SSH
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    type: text("type").notNull(), // password|private_key|certificate
    // Envelope-encrypted JSON payload: { password? , privateKey?, passphrase?, certificate? }
    encryptedSecret: jsonb("encrypted_secret").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    fingerprint: text("fingerprint"), // public fingerprint for keys (non-sensitive)
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    ...optimistic,
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("credentials_ws_idx").on(t.workspaceId)],
);

export const sshHosts = pgTable(
  "ssh_hosts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    groupId: uuid("group_id").references(() => hostGroups.id),
    projectId: uuid("project_id").references(() => projects.id),
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    authType: text("auth_type").notNull(), // password|private_key|certificate
    credentialId: uuid("credential_id").references(() => credentials.id),
    proxyJumpHostId: uuid("proxy_jump_host_id"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    environment: text("environment").notNull().default("development"),
    encoding: text("encoding").notNull().default("utf-8"),
    keepaliveInterval: integer("keepalive_interval").notNull().default(30),
    connectionTimeout: integer("connection_timeout").notNull().default(15),
    maxSessionDuration: integer("max_session_duration").notNull().default(8 * 3600),
    hostKeyPolicy: text("host_key_policy").notNull().default("strict"), // strict|tofu
    allowAgentForwarding: boolean("allow_agent_forwarding").notNull().default(false),
    allowPortForwarding: boolean("allow_port_forwarding").notNull().default(false),
    isFavorite: boolean("is_favorite").notNull().default(false),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastLatencyMs: integer("last_latency_ms"),
    createdBy: uuid("created_by").references(() => users.id),
    ...optimistic,
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("ssh_hosts_ws_idx").on(t.workspaceId), index("ssh_hosts_env_idx").on(t.workspaceId, t.environment)],
);

export const credentialBindings = pgTable("credential_bindings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  credentialId: uuid("credential_id").notNull().references(() => credentials.id),
  hostId: uuid("host_id").notNull().references(() => sshHosts.id),
  ...timestamps,
});

export const sshHostKeys = pgTable(
  "ssh_host_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    hostId: uuid("host_id").notNull().references(() => sshHosts.id),
    keyType: text("key_type").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    publicKey: text("public_key").notNull(),
    status: text("status").notNull().default("pending"), // pending|trusted|revoked
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("ssh_host_keys_host_idx").on(t.hostId)],
);

export const terminalSessions = pgTable(
  "terminal_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    hostId: uuid("host_id").notNull().references(() => sshHosts.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    title: text("title"),
    status: text("status").notNull().default("connecting"), // connecting|active|closed|failed
    closeReason: text("close_reason"),
    nodeId: text("node_id"),
    cols: integer("cols").notNull().default(80),
    rows: integer("rows").notNull().default(24),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    bytesIn: integer("bytes_in").notNull().default(0),
    bytesOut: integer("bytes_out").notNull().default(0),
    recordingEnabled: boolean("recording_enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("terminal_sessions_user_idx").on(t.userId), index("terminal_sessions_ws_idx").on(t.workspaceId)],
);

// Append-only event stream used for replay. Kind distinguishes raw output,
// user input, AI suggestions and AI executed actions.
export const terminalEvents = pgTable(
  "terminal_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    sessionId: uuid("session_id").notNull().references(() => terminalSessions.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // output|input|ai_suggestion|ai_exec|approval|resize|system
    offsetMs: integer("offset_ms").notNull(),
    data: text("data").notNull(),
    redacted: boolean("redacted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("terminal_events_session_idx").on(t.sessionId, t.seq)],
);

export const terminalRecordings = pgTable("terminal_recordings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => terminalSessions.id),
  storage: text("storage").notNull().default("db"), // db|s3
  objectKey: text("object_key"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  ...timestamps,
});

// ---------------------------------------------------------------- AI
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    ownerUserId: uuid("owner_user_id").references(() => users.id), // null => tenant-wide
    name: text("name").notNull(),
    kind: text("kind").notNull(), // mock|openai|openai_compatible|anthropic|ollama|azure_openai|gemini
    baseUrl: text("base_url"),
    encryptedApiKey: jsonb("encrypted_api_key"),
    encryptedHeaders: jsonb("encrypted_headers"),
    defaultModel: text("default_model").notNull(),
    embeddingModel: text("embedding_model"),
    contextWindow: integer("context_window").notNull().default(128000),
    maxOutputTokens: integer("max_output_tokens").notNull().default(4096),
    timeoutMs: integer("timeout_ms").notNull().default(60000),
    maxRetries: integer("max_retries").notNull().default(2),
    streamingEnabled: boolean("streaming_enabled").notNull().default(true),
    tlsVerify: boolean("tls_verify").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("model_providers_org_idx").on(t.orgId)],
);

export const modelConfigs = pgTable("model_configs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  purpose: text("purpose").notNull(), // default|agent|fast|reasoning|embedding
  providerId: uuid("provider_id").notNull().references(() => modelProviders.id),
  model: text("model").notNull(),
  ...timestamps,
});

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    terminalSessionId: uuid("terminal_session_id").references(() => terminalSessions.id),
    hostId: uuid("host_id").references(() => sshHosts.id),
    title: text("title"),
    mode: text("mode").notNull().default("suggest"), // ask|suggest|approval|auto|plan
    providerId: uuid("provider_id").references(() => modelProviders.id),
    model: text("model"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("agent_conversations_user_idx").on(t.userId)],
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => agentConversations.id),
    runId: uuid("run_id"),
    role: text("role").notNull(), // system|user|assistant|tool
    content: text("content").notNull().default(""),
    toolCalls: jsonb("tool_calls"),
    toolCallId: text("tool_call_id"),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_messages_conv_idx").on(t.conversationId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => agentConversations.id),
    userId: uuid("user_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("running"), // running|waiting_approval|completed|failed|cancelled
    providerId: uuid("provider_id"),
    model: text("model"),
    iterations: integer("iterations").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_conv_idx").on(t.conversationId)],
);

export const agentToolCalls = pgTable(
  "agent_tool_calls",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    conversationId: uuid("conversation_id").notNull(),
    providerCallId: text("provider_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    riskLevel: text("risk_level").notNull(), // R0..R4
    decision: text("decision").notNull(), // allow|approval_required|blocked
    policyFindings: jsonb("policy_findings").notNull().default([]),
    status: text("status").notNull().default("pending"), // pending|approved|rejected|executed|failed|blocked
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("agent_tool_calls_run_idx").on(t.runId)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    requestedBy: uuid("requested_by").notNull(), // the user whose agent asked
    toolCallId: uuid("tool_call_id").references(() => agentToolCalls.id),
    hostId: uuid("host_id"),
    terminalSessionId: uuid("terminal_session_id"),
    kind: text("kind").notNull(), // tool_call|workflow|host_key
    summary: text("summary").notNull(),
    details: jsonb("details").notNull().default({}),
    riskLevel: text("risk_level").notNull(),
    status: text("status").notNull().default("pending"), // pending|approved|rejected|expired
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("approvals_status_idx").on(t.workspaceId, t.status)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id"),
    providerId: uuid("provider_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    latencyMs: integer("latency_ms"),
    success: boolean("success").notNull().default(true),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_records_org_time_idx").on(t.orgId, t.createdAt)],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id"),
    scope: text("scope").notNull(), // user|host|project|workspace|team
    scopeRef: text("scope_ref"),
    content: text("content").notNull(),
    source: text("source").notNull(), // user|agent|import
    // pgvector column is added by migration when the extension is available;
    // kept nullable jsonb fallback for environments without pgvector.
    embedding: jsonb("embedding"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index("memories_scope_idx").on(t.orgId, t.scope, t.scopeRef)],
);

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source"),
  ...timestamps,
  ...softDelete,
});

// ---------------------------------------------------------------- extensions
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    orgId: uuid("org_id").notNull(),
    skillId: text("skill_id").notNull(), // manifest id e.g. io.webssh.linux-inspector
    name: text("name").notNull(),
    description: text("description"),
    author: text("author"),
    license: text("license"),
    latestVersion: text("latest_version").notNull(),
    status: text("status").notNull().default("pending_review"), // pending_review|approved|rejected
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("skills_org_skillid_uq").on(t.orgId, t.skillId)],
);

export const skillVersions = pgTable("skill_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  skillId: uuid("skill_id").notNull().references(() => skills.id),
  version: text("version").notNull(),
  manifest: jsonb("manifest").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  signatureVerified: boolean("signature_verified").notNull().default(false),
  source: text("source").notNull(), // upload|git|url|registry
  ...timestamps,
});

export const skillInstallations = pgTable("skill_installations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  skillVersionId: uuid("skill_version_id").notNull().references(() => skillVersions.id),
  enabled: boolean("enabled").notNull().default(false),
  grantedPermissions: jsonb("granted_permissions").$type<string[]>().notNull().default([]),
  config: jsonb("config").notNull().default({}),
  installedBy: uuid("installed_by"),
  ...timestamps,
});

export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  transport: text("transport").notNull(), // stdio|sse|streamable_http
  command: text("command"),
  args: jsonb("args").$type<string[]>().notNull().default([]),
  url: text("url"),
  envSecretRefs: jsonb("env_secret_refs").notNull().default({}),
  headersSecretRefs: jsonb("headers_secret_refs").notNull().default({}),
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
  deniedTools: jsonb("denied_tools").$type<string[]>().notNull().default([]),
  resourceLimits: jsonb("resource_limits").notNull().default({}),
  autoStart: boolean("auto_start").notNull().default(false),
  status: text("status").notNull().default("stopped"),
  ...timestamps,
  ...softDelete,
});

export const mcpTools = pgTable("mcp_tools", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  serverId: uuid("server_id").notNull().references(() => mcpServers.id),
  name: text("name").notNull(),
  description: text("description"),
  inputSchema: jsonb("input_schema").notNull().default({}),
  riskLevel: text("risk_level").notNull().default("R2"),
  enabled: boolean("enabled").notNull().default(false),
  ...timestamps,
});

export const plugins = pgTable("plugins", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // ui|integration|agent_tool|auth|notification|secret|llm
  version: text("version").notNull(),
  manifest: jsonb("manifest").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  ...timestamps,
  ...softDelete,
});

export const pluginInstallations = pgTable("plugin_installations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id"),
  pluginId: uuid("plugin_id").notNull().references(() => plugins.id),
  enabled: boolean("enabled").notNull().default(false),
  config: jsonb("config").notNull().default({}),
  ...timestamps,
});

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  riskSummary: text("risk_summary"),
  approvalPolicy: text("approval_policy").notNull().default("manual"),
  createdBy: uuid("created_by"),
  ...optimistic,
  ...timestamps,
  ...softDelete,
});

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  status: text("status").notNull().default("pending"),
  dryRun: boolean("dry_run").notNull().default(true),
  triggeredBy: uuid("triggered_by"),
  log: jsonb("log").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id"),
  kind: text("kind").notNull(), // report|script|diff|file
  name: text("name").notNull(),
  contentType: text("content_type").notNull().default("text/plain"),
  content: text("content"),
  objectKey: text("object_key"),
  runId: uuid("run_id"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // command|access|provider_allowlist
  rules: jsonb("rules").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- audit
// Append-only. A DB trigger (drizzle/sql/audit_guard.sql) rejects UPDATE/DELETE,
// and `integrityHash` chains each row to the previous row of the same tenant.
export const auditEvents = pgTable(
  "audit_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    eventId: uuid("event_id").notNull().default(sql`gen_random_uuid()`),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    tenantId: uuid("tenant_id"),
    workspaceId: uuid("workspace_id"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    action: text("action").notNull(),
    result: text("result").notNull(), // success|failure|denied
    riskLevel: text("risk_level").notNull().default("R0"),
    requestId: text("request_id"),
    sessionId: text("session_id"),
    metadata: jsonb("metadata").notNull().default({}),
    previousHash: text("previous_hash"),
    integrityHash: text("integrity_hash").notNull(),
  },
  (t) => [
    index("audit_events_tenant_time_idx").on(t.tenantId, t.timestamp),
    index("audit_events_action_idx").on(t.action),
    uniqueIndex("audit_events_event_id_uq").on(t.eventId),
  ],
);
