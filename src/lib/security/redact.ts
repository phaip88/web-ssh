/**
 * Detects and masks secrets before text reaches logs, audit metadata or
 * external LLM providers. Patterns are intentionally broad; false positives
 * are preferable to leaking credentials.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github_token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._\-+/=]+/gi },
  { name: "kv_secret", re: /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)(["']?)[^\s"'&]{4,}\2/gi },
  { name: "url_credentials", re: /(\w+:\/\/[^:/\s]+:)([^@/\s]+)(@)/g },
];

export interface RedactionResult {
  text: string;
  findings: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const findings: string[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      findings.push(p.name);
      p.re.lastIndex = 0;
      text = text.replace(p.re, (m: string, ...groups: string[]) => {
        if (p.name === "bearer" || p.name === "kv_secret") return `${groups[0]}[REDACTED]`;
        if (p.name === "url_credentials") return `${groups[0]}[REDACTED]${groups[2]}`;
        return `[REDACTED:${p.name}]`;
      });
    }
    p.re.lastIndex = 0;
  }
  return { text, findings };
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map(redactObject) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /(password|secret|token|apikey|api_key|privatekey|private_key|passphrase)/i.test(k)
        ? "[REDACTED]"
        : redactObject(v);
    }
    return out as T;
  }
  return value;
}

export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return "*".repeat(value.length);
  return `${"*".repeat(Math.min(12, value.length - visible))}${value.slice(-visible)}`;
}
