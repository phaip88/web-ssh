import { z } from "zod";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { modelProviders } from "@/db/schema";
import { authorize } from "@/lib/auth/rbac";
import { audit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto/envelope";
import { ApiError, handler, json, parseBody, requireAuth } from "@/lib/http";
import { assertSafeUrl, SsrfViolation } from "@/lib/llm/ssrf-guard";
import { maskTail } from "@/lib/security/redact";
import { resolveWorkspace, workspaceIdFrom } from "@/lib/tenancy";

const schema = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(["mock", "openai", "openai_compatible", "azure_openai", "anthropic", "ollama", "vllm"]),
  baseUrl: z.string().url().max(2048).optional(),
  apiKey: z.string().max(4096).optional(),
  headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
  defaultModel: z.string().min(1).max(120),
  embeddingModel: z.string().max(120).optional(),
  contextWindow: z.number().int().min(2000).max(2_000_000).default(128000),
  maxOutputTokens: z.number().int().min(64).max(128000).default(4096),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  streamingEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  private: z.boolean().default(false),
});

const publicShape = { id: modelProviders.id, name: modelProviders.name, kind: modelProviders.kind, baseUrl: modelProviders.baseUrl, defaultModel: modelProviders.defaultModel, embeddingModel: modelProviders.embeddingModel, contextWindow: modelProviders.contextWindow, maxOutputTokens: modelProviders.maxOutputTokens, timeoutMs: modelProviders.timeoutMs, streamingEnabled: modelProviders.streamingEnabled, isDefault: modelProviders.isDefault, enabled: modelProviders.enabled, ownerUserId: modelProviders.ownerUserId, encryptedApiKey: modelProviders.encryptedApiKey, createdAt: modelProviders.createdAt };

export const GET = handler(async (req) => {
  const ctx = await requireAuth(req);
  const scope = await resolveWorkspace(ctx, workspaceIdFrom(req));
  authorize(ctx, scope, "agent:use");
  const rows = await db.select(publicShape).from(modelProviders).where(and(eq(modelProviders.orgId, scope.orgId), isNull(modelProviders.deletedAt), or(isNull(modelProviders.ownerUserId), eq(modelProviders.ownerUserId, ctx.user.id)))).orderBy(desc(modelProviders.isDefault), modelProviders.createdAt);
  return json(rows.map(({ encryptedApiKey, ...r }) => ({ ...r, hasApiKey: !!encryptedApiKey })));
});

export const POST = handler(async (req) => {
  const ctx = await requireAuth(req);
  const body = await parseBody(req, schema);
  const scope = await resolveWorkspace(ctx, body.workspaceId);
  // Tenant-wide providers need providers:manage; any agent user may add a private provider.
  authorize(ctx, scope, body.private ? "agent:use" : "providers:manage");
  if (body.baseUrl) {
    try {
      await assertSafeUrl(body.baseUrl);
    } catch (err) {
      if (err instanceof SsrfViolation) throw new ApiError("VALIDATION_ERROR", `Base URL rejected: ${err.message}`);
      throw err;
    }
  }
  if (body.kind !== "mock" && body.kind !== "ollama" && !body.apiKey) throw new ApiError("VALIDATION_ERROR", "apiKey is required for this provider kind");
  const id = crypto.randomUUID();
  if (body.isDefault && !body.private) await db.update(modelProviders).set({ isDefault: false }).where(and(eq(modelProviders.orgId, scope.orgId), isNull(modelProviders.ownerUserId)));
  const [row] = await db
    .insert(modelProviders)
    .values({
      id,
      orgId: scope.orgId,
      ownerUserId: body.private ? ctx.user.id : null,
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl ?? null,
      encryptedApiKey: body.apiKey ? encryptSecret(body.apiKey, `provider:${id}`) : null,
      encryptedHeaders: body.headers ? encryptSecret(JSON.stringify(body.headers), `provider-headers:${id}`) : null,
      defaultModel: body.defaultModel,
      embeddingModel: body.embeddingModel ?? null,
      contextWindow: body.contextWindow,
      maxOutputTokens: body.maxOutputTokens,
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      streamingEnabled: body.streamingEnabled,
      isDefault: body.isDefault,
    })
    .returning(publicShape);
  await audit({ actor: ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "model_provider", resourceId: row.id, action: "provider.created", result: "success", riskLevel: "R2", metadata: { kind: row.kind, baseUrl: row.baseUrl, apiKey: body.apiKey ? maskTail(body.apiKey) : null, private: body.private } });
  const { encryptedApiKey, ...pub } = row;
  return json({ ...pub, hasApiKey: !!encryptedApiKey }, { status: 201 });
});
