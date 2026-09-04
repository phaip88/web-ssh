/**
 * Anthropic Messages API adapter (non-streaming request, streamed to the client
 * as a single delta). Tool calls map to Anthropic `tool_use` blocks.
 */
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, ProviderConfig, ProviderCredentials, StreamEvent, ToolCallRequest } from "../types";
import { messagesTokenEstimate } from "../types";
import { safeFetch } from "../ssrf-guard";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string };

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = "anthropic";
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly creds: ProviderCredentials,
  ) {}

  private base() {
    return (this.cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }
  private headers(): Record<string, string> {
    return { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": this.creds.apiKey ?? "", ...(this.creds.headers ?? {}) };
  }

  async listModels() {
    const res = await safeFetch(`${this.base()}/v1/models`, { headers: this.headers() });
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }
  async validateCredential() {
    try {
      await this.listModels();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "failed" };
    }
  }
  countTokens(messages: ChatMessage[]) {
    return messagesTokenEstimate(messages);
  }
  async embeddings(): Promise<number[][]> {
    throw new Error("Anthropic does not provide an embeddings endpoint; configure a separate embedding provider");
  }
  async healthCheck() {
    const t = Date.now();
    const v = await this.validateCredential();
    return { ok: v.ok, latencyMs: Date.now() - t, message: v.message };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages: { role: "user" | "assistant"; content: Block[] | string }[] = [];
    for (const m of req.messages) {
      if (m.role === "system") continue;
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const blocks: Block[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const t of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.arguments });
        messages.push({ role: "assistant", content: blocks });
      } else if (m.role === "tool") {
        const last = messages[messages.length - 1];
        const block: Block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
        else messages.push({ role: "user", content: [block] });
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    req.signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await safeFetch(`${this.base()}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxOutputTokens ?? this.cfg.maxOutputTokens,
          system: system || undefined,
          messages,
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
        }),
      });
      const json = (await res.json()) as { content?: Block[]; usage?: { input_tokens: number; output_tokens: number }; stop_reason?: string; error?: { message: string } };
      if (!res.ok) throw new Error(`Provider error: ${json.error?.message ?? res.status}`);
      const text = (json.content ?? []).filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
      const toolCalls: ToolCallRequest[] = (json.content ?? []).filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
      return {
        content: text,
        toolCalls,
        usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
        finishReason: toolCalls.length ? "tool_calls" : json.stop_reason === "max_tokens" ? "length" : "stop",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const r = await this.chat(req);
    yield { type: "delta", text: r.content };
    yield { type: "done", result: r };
  }
}
