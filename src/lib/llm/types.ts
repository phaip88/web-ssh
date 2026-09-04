/**
 * Provider-agnostic chat/tool-calling contract. Every vendor adapter maps its
 * wire format onto these types so the agent runtime never sees vendor SDKs.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCallRequest[];
  usage: ChatUsage;
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; result: ChatResult };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderCredentials {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ProviderConfig {
  id: string;
  kind: string;
  name: string;
  baseUrl: string | null;
  defaultModel: string;
  timeoutMs: number;
  maxRetries: number;
  tlsVerify: boolean;
  streamingEnabled: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderAdapter {
  readonly kind: string;
  listModels(): Promise<string[]>;
  validateCredential(): Promise<{ ok: boolean; message?: string }>;
  chat(req: ChatRequest): Promise<ChatResult>;
  streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void>;
  countTokens(messages: ChatMessage[]): number;
  embeddings(input: string[], model?: string): Promise<number[][]>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
}

/** Cheap, vendor-neutral token estimate used for budgeting when the vendor offers no tokenizer. */
export function estimateTokens(text: string): number {
  // ~4 chars/token for English, CJK closer to 1.5 chars/token.
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af]/.test(ch)) cjk++;
  return Math.ceil((text.length - cjk) / 4 + cjk / 1.5);
}

export function messagesTokenEstimate(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + 4 + estimateTokens("content" in m ? m.content : "") + ("toolCalls" in m && m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0), 0);
}
