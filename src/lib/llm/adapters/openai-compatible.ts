/**
 * Adapter for OpenAI and OpenAI-compatible endpoints (vLLM, Ollama /v1,
 * LM Studio, Azure with api-version header, custom gateways).
 */
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, ProviderConfig, ProviderCredentials, StreamEvent, ToolCallRequest } from "../types";
import { messagesTokenEstimate } from "../types";
import { safeFetch } from "../ssrf-guard";

interface OaiToolCall {
  id?: string;
  index?: number;
  type?: "function";
  function?: { name?: string; arguments?: string };
}
interface OaiChoice {
  message?: { content?: string | null; tool_calls?: OaiToolCall[] };
  delta?: { content?: string | null; tool_calls?: OaiToolCall[] };
  finish_reason?: string | null;
}
interface OaiResponse {
  choices?: OaiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  data?: { id: string }[];
  error?: { message?: string };
}

function toWire(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) }
          : {}),
      };
    return { role: m.role, content: m.content };
  });
}

function parseArgs(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
  } catch {
    return { _raw: s };
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind: string;
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly creds: ProviderCredentials,
  ) {
    this.kind = cfg.kind;
  }

  private base(): string {
    const b = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return b;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...(this.creds.headers ?? {}) };
    if (this.creds.apiKey) {
      if (this.cfg.kind === "azure_openai") h["api-key"] = this.creds.apiKey;
      else h.authorization = `Bearer ${this.creds.apiKey}`;
    }
    return h;
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    signal?.addEventListener("abort", () => ctrl.abort());
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.cfg.maxRetries) {
      try {
        const res = await safeFetch(`${this.base()}${path}`, { method: body ? "POST" : "GET", headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Provider returned ${res.status}`);
          attempt++;
          await new Promise((r) => setTimeout(r, Math.min(8000, 300 * 2 ** attempt)));
          continue;
        }
        clearTimeout(timer);
        return res;
      } catch (err) {
        lastErr = err;
        if (ctrl.signal.aborted) break;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(8000, 300 * 2 ** attempt)));
      }
    }
    clearTimeout(timer);
    throw lastErr instanceof Error ? lastErr : new Error("Provider request failed");
  }

  async listModels(): Promise<string[]> {
    const res = await this.request("/models", undefined);
    const json = (await res.json()) as OaiResponse;
    return (json.data ?? []).map((d) => d.id);
  }

  async validateCredential() {
    try {
      await this.listModels();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "validation failed" };
    }
  }

  countTokens(messages: ChatMessage[]) {
    return messagesTokenEstimate(messages);
  }

  async embeddings(input: string[], model?: string): Promise<number[][]> {
    const res = await this.request("/embeddings", { model: model ?? "text-embedding-3-small", input });
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    return (json.data ?? []).map((d) => d.embedding);
  }

  async healthCheck() {
    const t = Date.now();
    const v = await this.validateCredential();
    return { ok: v.ok, latencyMs: Date.now() - t, message: v.message };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.request(
      "/chat/completions",
      {
        model: req.model,
        messages: toWire(req.messages),
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxOutputTokens ?? this.cfg.maxOutputTokens,
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" } : {}),
      },
      req.signal,
    );
    const json = (await res.json()) as OaiResponse;
    if (!res.ok) throw new Error(`Provider error: ${json.error?.message ?? res.status}`);
    const choice = json.choices?.[0];
    const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls ?? []).map((t, i) => ({ id: t.id ?? `call_${i}`, name: t.function?.name ?? "", arguments: parseArgs(t.function?.arguments) }));
    return {
      content: choice?.message?.content ?? "",
      toolCalls,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      finishReason: toolCalls.length ? "tool_calls" : choice?.finish_reason === "length" ? "length" : "stop",
    };
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    if (!this.cfg.streamingEnabled) {
      const r = await this.chat(req);
      yield { type: "delta", text: r.content };
      yield { type: "done", result: r };
      return;
    }
    const res = await this.request(
      "/chat/completions",
      {
        model: req.model,
        messages: toWire(req.messages),
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxOutputTokens ?? this.cfg.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" } : {}),
      },
      req.signal,
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Provider error ${res.status}: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let json: OaiResponse;
        try {
          json = JSON.parse(payload) as OaiResponse;
        } catch {
          continue;
        }
        if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          content += choice.delta.content;
          yield { type: "delta", text: choice.delta.content };
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    const toolCalls: ToolCallRequest[] = [...calls.values()].map((c) => ({ id: c.id, name: c.name, arguments: parseArgs(c.args) }));
    yield { type: "done", result: { content, toolCalls, usage, finishReason: toolCalls.length ? "tool_calls" : finish === "length" ? "length" : "stop" } };
  }
}
