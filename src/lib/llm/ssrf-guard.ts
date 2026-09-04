/**
 * SSRF protection for user-supplied provider/MCP URLs. Validates scheme,
 * rejects private/link-local/metadata destinations after DNS resolution and
 * re-validates on every redirect hop (DNS rebinding + open-redirect defence).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "@/lib/config";

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "kubernetes.default.svc"]);

export function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice(7));
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

export class SsrfViolation extends Error {
  code = "SSRF_BLOCKED" as const;
}

export interface UrlPolicy {
  allowPrivate?: boolean;
  allowHttp?: boolean;
  allowlist?: string[]; // hostnames explicitly allowed by an administrator
}

/**
 * Resolves and validates a URL. Returns the resolved IP so the caller can pin it.
 */
export async function assertSafeUrl(rawUrl: string, policy: UrlPolicy = {}): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfViolation("Invalid URL");
  }
  const allowHttp = policy.allowHttp ?? config.providerAllowHttp();
  const allowPrivate = policy.allowPrivate ?? config.providerAllowPrivateHosts();
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new SsrfViolation(`Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new SsrfViolation("Credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (policy.allowlist?.includes(host)) {
    const addr = isIP(host) ? host : (await lookup(host)).address;
    return { url, address: addr };
  }
  if (METADATA_HOSTS.has(host) || host.endsWith(".internal") || host === "localhost" || host.endsWith(".localhost")) {
    if (!allowPrivate) throw new SsrfViolation("Destination host is not allowed");
  }
  let address: string;
  if (isIP(host)) address = host;
  else {
    try {
      address = (await lookup(host)).address;
    } catch {
      throw new SsrfViolation("Destination host could not be resolved");
    }
  }
  if (!allowPrivate && isPrivateAddress(address)) {
    throw new SsrfViolation("Destination resolves to a private or metadata address");
  }
  if (address === "169.254.169.254" || address === "fd00:ec2::254") {
    // Cloud metadata endpoints are never allowed, even with allowPrivate.
    throw new SsrfViolation("Cloud metadata endpoint is forbidden");
  }
  return { url, address };
}

/**
 * fetch wrapper that validates the initial URL and every redirect target.
 */
export async function safeFetch(rawUrl: string, init: RequestInit & { policy?: UrlPolicy; maxRedirects?: number } = {}): Promise<Response> {
  const { policy, maxRedirects = 3, ...rest } = init;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, policy);
    const res = await fetch(current, { ...rest, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfViolation("Too many redirects");
}
