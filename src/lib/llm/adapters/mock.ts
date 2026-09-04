/**
 * Deterministic mock provider. It exercises the full tool-calling loop
 * (text -> tool request -> tool result -> summary) without network access, so
 * the end-to-end approval flow can be demonstrated and tested offline.
 */
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, StreamEvent } from "../types";
import { estimateTokens, messagesTokenEstimate } from "../types";

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content;
  }
  return "";
}

function lastToolResult(messages: ChatMessage[]): { name: string; content: string } | null {
  const m = messages[messages.length - 1];
  return m && m.role === "tool" ? { name: m.name, content: m.content } : null;
}

function pickCommand(text: string): { command: string; rationale: string } | null {
  const t = text.toLowerCase();
  if (/(wipe|format disk|清空磁盘|nuke)/.test(t)) return { command: "rm -rf /var", rationale: "Simulated hostile suggestion – the policy engine must hard-block this." };
  if (/(rm -rf|delete everything|清空|删除所有)/.test(t)) return { command: "rm -rf /var/lib/app", rationale: "You asked for a destructive cleanup; this will be evaluated by the policy engine." };
  if (/(disk|磁盘|space|空间|df)/.test(t)) return { command: "df -h", rationale: "Check filesystem usage to confirm the disk pressure hinted at in the logs." };
  if (/(memory|内存|oom|free)/.test(t)) return { command: "free -m", rationale: "Inspect memory headroom because the log mentions an OOM kill." };
  if (/(process|进程|cpu|top|ps)/.test(t)) return { command: "ps aux", rationale: "List processes to find the CPU/memory hog." };
  if (/(service|服务|systemd|restart|重启)/.test(t)) return { command: "systemctl status app", rationale: "Check the unit state before proposing any restart." };
  if (/(docker|container|容器)/.test(t)) return { command: "docker ps", rationale: "Enumerate containers and their restart state." };
  if (/(k8s|kubernetes|pod)/.test(t)) return { command: "kubectl get pods", rationale: "Inspect pod status for crash loops." };
  if (/(log|日志|error|错误|analy|分析|why|为什么|fail|失败|排查)/.test(t)) return { command: "tail -n 20 /var/log/app/app.log", rationale: "Read the most recent application log lines to identify the failure mode." };
  return null;
}

function summarize(tool: string, content: string): string {
  const parsed = safeJson(content);
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : content;
  const lines = stdout.trim().split("\n").filter(Boolean);
  const bullet = lines.slice(0, 6).map((l) => `- \`${l.slice(0, 140)}\``).join("\n");
  const hints: string[] = [];
  if (/9[0-9]%|100%/.test(stdout)) hints.push("A filesystem is above 90% usage – free space or expand the volume before the service starts failing writes.");
  if (/OOM|out of memory|oom-kill/i.test(stdout)) hints.push("The kernel OOM killer terminated a worker; the process is exceeding available RAM. Consider raising limits or fixing a leak.");
  if (/pool exhausted|timeout acquiring/i.test(stdout)) hints.push("The DB connection pool is exhausted; requests are queueing and timing out. Check slow queries and pool_size in config.yaml.");
  if (/CrashLoopBackOff|Restarting \(137\)/.test(stdout)) hints.push("A workload is crash-looping with exit 137 (OOM). Inspect resource limits.");
  if (/activating \(auto-restart\)/.test(stdout)) hints.push("systemd is repeatedly restarting the unit. Review `journalctl -u app` for the root cause before restarting manually.");
  return `**Result of \`${tool}\`:**\n${bullet}${lines.length > 6 ? `\n- … (${lines.length - 6} more lines)` : ""}\n\n**Assessment:**\n${hints.length ? hints.map((h) => `- ${h}`).join("\n") : "- No obvious anomaly in this output. Consider checking memory (`free -m`) and service status next."}\n\n_Next step suggestions are read-only; nothing has been changed on the host._`;
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class MockAdapter implements ProviderAdapter {
  readonly kind = "mock";
  constructor(private readonly model = "mock-agent-1") {}

  async listModels() {
    return [this.model, "mock-fast-1"];
  }
  async validateCredential() {
    return { ok: true };
  }
  countTokens(messages: ChatMessage[]) {
    return messagesTokenEstimate(messages);
  }
  async embeddings(input: string[]) {
    return input.map((s) => Array.from({ length: 8 }, (_, i) => ((s.charCodeAt(i % s.length) || 0) % 97) / 97));
  }
  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const toolsAllowed = (req.tools ?? []).some((t) => t.name === "terminal.execute");
    const input = messagesTokenEstimate(req.messages);
    const tr = lastToolResult(req.messages);
    if (tr) {
      const content = summarize(tr.name, tr.content);
      return { content, toolCalls: [], usage: { inputTokens: input, outputTokens: estimateTokens(content) }, finishReason: "stop" };
    }
    const user = lastUser(req.messages);
    const pick = pickCommand(user);
    if (pick && toolsAllowed) {
      const content = `${pick.rationale}\n\nI'd like to run \`${pick.command}\` on the current host.`;
      return {
        content,
        toolCalls: [{ id: `call_${Date.now().toString(36)}`, name: "terminal.execute", arguments: { command: pick.command, reason: pick.rationale } }],
        usage: { inputTokens: input, outputTokens: estimateTokens(content) },
        finishReason: "tool_calls",
      };
    }
    const content = pick
      ? `Suggested command (not executed – current mode does not allow tool calls):\n\n\`\`\`bash\n${pick.command}\n\`\`\`\n${pick.rationale}`
      : `I'm the built-in mock model. I can help you inspect logs, disk, memory, processes, services, containers and pods on the connected host. Ask something like "analyze the latest errors" or "why is the disk full?".\n\nContext I was given:\n${req.messages.filter((m) => m.role === "system").map((m) => m.content.split("\n").slice(0, 3).join("\n")).join("\n").slice(0, 400)}`;
    return { content, toolCalls: [], usage: { inputTokens: input, outputTokens: estimateTokens(content) }, finishReason: "stop" };
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const result = await this.chat(req);
    const words = result.content.split(/(\s+)/);
    for (const w of words) {
      if (req.signal?.aborted) return;
      yield { type: "delta", text: w };
      await new Promise((r) => setTimeout(r, 4));
    }
    yield { type: "done", result };
  }
}
