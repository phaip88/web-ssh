/**
 * Provider Gateway: resolves a tenant's provider record into an adapter,
 * decrypting credentials on demand, recording usage and applying a simple
 * circuit breaker per provider.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { modelProviders, usageRecords } from "@/db/schema";
import { decryptSecret, isEnvelopePayload } from "@/lib/crypto/envelope";
import { ApiError } from "@/lib/http";
import { MockAdapter } from "./adapters/mock";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible";
import { AnthropicAdapter } from "./adapters/anthropic";
import type { ProviderAdapter, ProviderConfig, ProviderCredentials } from "./types";

type ProviderRow = typeof modelProviders.$inferSelect;

const breaker = new Map<string, { failures: number; openUntil: number }>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

export function providerConfigFromRow(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    timeoutMs: row.timeoutMs,
    maxRetries: row.maxRetries,
    tlsVerify: row.tlsVerify,
    streamingEnabled: row.streamingEnabled,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
  };
}

function credentialsFromRow(row: ProviderRow): ProviderCredentials {
  const creds: ProviderCredentials = {};
  if (isEnvelopePayload(row.encryptedApiKey)) creds.apiKey = decryptSecret(row.encryptedApiKey, `provider:${row.id}`);
  if (isEnvelopePayload(row.encryptedHeaders)) creds.headers = JSON.parse(decryptSecret(row.encryptedHeaders, `provider-headers:${row.id}`)) as Record<string, string>;
  return creds;
}

export function createAdapter(cfg: ProviderConfig, creds: ProviderCredentials): ProviderAdapter {
  switch (cfg.kind) {
    case "mock":
      return new MockAdapter(cfg.defaultModel);
    case "anthropic":
      return new AnthropicAdapter(cfg, creds);
    case "openai":
    case "openai_compatible":
    case "azure_openai":
    case "ollama":
    case "vllm":
      return new OpenAICompatibleAdapter(cfg, creds);
    default:
      throw new ApiError("PROVIDER_ERROR", `Unsupported provider kind: ${cfg.kind}`);
  }
}

export async function resolveProvider(orgId: string, userId: string, providerId?: string | null): Promise<{ adapter: ProviderAdapter; config: ProviderConfig }> {
  const visible = and(eq(modelProviders.orgId, orgId), eq(modelProviders.enabled, true), isNull(modelProviders.deletedAt), or(isNull(modelProviders.ownerUserId), eq(modelProviders.ownerUserId, userId)));
  const rows = providerId
    ? await db.select().from(modelProviders).where(and(visible, eq(modelProviders.id, providerId))).limit(1)
    : await db.select().from(modelProviders).where(visible).orderBy(desc(modelProviders.isDefault), modelProviders.createdAt).limit(1);
  const row = rows[0];
  if (!row) throw new ApiError("NOT_FOUND", "No enabled model provider is configured");
  const b = breaker.get(row.id);
  if (b && b.openUntil > Date.now()) throw new ApiError("PROVIDER_ERROR", `Provider ${row.name} is temporarily unavailable (circuit open)`);
  const cfg = providerConfigFromRow(row);
  return { adapter: createAdapter(cfg, credentialsFromRow(row)), config: cfg };
}

export function recordProviderOutcome(providerId: string, ok: boolean) {
  const b = breaker.get(providerId) ?? { failures: 0, openUntil: 0 };
  if (ok) b.failures = 0;
  else {
    b.failures += 1;
    if (b.failures >= BREAKER_THRESHOLD) b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
  breaker.set(providerId, b);
}

export async function recordUsage(input: { orgId: string; workspaceId?: string | null; userId?: string | null; providerId: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number; success: boolean; runId?: string | null }) {
  try {
    await db.insert(usageRecords).values(input);
  } catch (err) {
    console.error("[usage] failed to record", String(err));
  }
}
