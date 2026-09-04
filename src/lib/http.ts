/**
 * Transport helpers for route handlers: stable error codes, schema validation,
 * CSRF (Origin) checks and auth wiring. Business logic lives in lib/*, never here.
 */
import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { getAuthContext, type AuthContext } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/rbac";
import { config } from "@/lib/config";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "CSRF_REJECTED"
  | "PAYLOAD_TOO_LARGE"
  | "HOST_KEY_UNKNOWN"
  | "HOST_KEY_MISMATCH"
  | "SSH_ERROR"
  | "POLICY_BLOCKED"
  | "PROVIDER_ERROR"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CSRF_REJECTED: 403,
  PAYLOAD_TOO_LARGE: 413,
  HOST_KEY_UNKNOWN: 428,
  HOST_KEY_MISMATCH: 409,
  SSH_ERROR: 502,
  POLICY_BLOCKED: 403,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null } },
      { status: STATUS[err.code] },
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: err.message } }, { status: 403 });
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.issues } },
      { status: 400 },
    );
  }
  console.error("[api] unhandled error", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Internal server error" } }, { status: 500 });
}

/** Origin/Referer check for state-changing requests (CSRF defence with SameSite cookies). */
export function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  if (!origin) throw new ApiError("CSRF_REJECTED", "Missing Origin header");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const allowed = new Set(config.allowedOrigins());
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError("CSRF_REJECTED", "Invalid Origin header");
  }
  if (allowed.has(origin) || (host && originHost === host)) return;
  throw new ApiError("CSRF_REJECTED", "Cross-origin request rejected");
}

export async function requireAuth(req: Request): Promise<AuthContext> {
  assertSameOrigin(req);
  const ctx = await getAuthContext();
  if (!ctx) throw new ApiError("UNAUTHENTICATED", "Authentication required");
  return ctx;
}

export async function parseBody<T>(req: Request, schema: ZodType<T>, maxBytes = 256 * 1024): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`);
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Body must be valid JSON");
  }
  return schema.parse(raw);
}

export function handler(fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// ---- simple in-memory rate limiter (per process; Redis-backed in multi-node deployments)
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw new ApiError("RATE_LIMITED", "Too many requests");
}
