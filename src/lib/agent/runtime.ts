/**
 * Agent Runtime: a small explicit state machine
 *   running -> (tool call) -> policy -> [allow: execute | approval_required: pause | blocked: feed refusal]
 *   waiting_approval -> (decision) -> execute/reject -> running -> ... -> completed|failed|cancelled
 *
 * Tool calls never touch SSH directly: they go through the registry, the
 * policy engine, RBAC and the approval table, and every step is audited.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentConversations, agentMessages, agentRuns, agentToolCalls, approvals, sshHosts } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hasPermission } from "@/lib/auth/rbac";
import type { AuthContext } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { recordProviderOutcome, recordUsage, resolveProvider } from "@/lib/llm/gateway";
import type { ToolCallRequest } from "@/lib/llm/types";
import { decideCommand, type AgentMode, type Decision, type Finding, type RiskLevel } from "@/lib/policy/command-policy";
import { envelope, type ServerMessage } from "@/lib/protocol/messages";
import { redactObject } from "@/lib/security/redact";
import { getLive, recordEvent, type LiveSession } from "@/lib/ssh/registry";
import { buildContext } from "./context";
import { toolRegistry, type ToolSpec } from "./tools";

export type Emit = (msg: ServerMessage) => void;

const MAX_ITERATIONS = 8;

interface RunEnv {
  ctx: AuthContext;
  conversation: typeof agentConversations.$inferSelect;
  run: typeof agentRuns.$inferSelect;
  session: LiveSession | null;
  environment: string;
  emit: Emit;
  signal?: AbortSignal;
}

async function loadEnv(ctx: AuthContext, conversationId: string, emit: Emit, signal?: AbortSignal, runId?: string): Promise<RunEnv> {
  const [conversation] = await db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)).limit(1);
  if (!conversation || conversation.userId !== ctx.user.id) throw new Error("Conversation not found");
  const session = conversation.terminalSessionId ? (getLive(conversation.terminalSessionId) ?? null) : null;
  let environment = "development";
  if (conversation.hostId) {
    const [host] = await db.select({ environment: sshHosts.environment }).from(sshHosts).where(eq(sshHosts.id, conversation.hostId)).limit(1);
    environment = host?.environment ?? environment;
  }
  let run: typeof agentRuns.$inferSelect;
  if (runId) {
    const [existing] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!existing) throw new Error("Run not found");
    run = existing;
  } else {
    [run] = await db.insert(agentRuns).values({ orgId: conversation.orgId, conversationId, userId: ctx.user.id, mode: conversation.mode, providerId: conversation.providerId, model: conversation.model }).returning();
  }
  return { ctx, conversation, run, session, environment, emit, signal };
}

export async function startRun(ctx: AuthContext, conversationId: string, userMessage: string, emit: Emit, signal?: AbortSignal): Promise<string> {
  const env = await loadEnv(ctx, conversationId, emit, signal);
  await db.insert(agentMessages).values({ orgId: env.conversation.orgId, conversationId, runId: env.run.id, role: "user", content: userMessage });
  await audit({ actor: ctx, tenantId: env.conversation.orgId, workspaceId: env.conversation.workspaceId, resourceType: "agent_run", resourceId: env.run.id, action: "agent.run.started", result: "success", sessionId: env.conversation.terminalSessionId, metadata: { mode: env.conversation.mode, messageChars: userMessage.length } });
  await loop(env);
  return env.run.id;
}

export async function resumeRun(ctx: AuthContext, runId: string, emit: Emit, signal?: AbortSignal): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) throw new Error("Run not found");
  const env = await loadEnv(ctx, run.conversationId, emit, signal, runId);
  await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
  await loop(env);
}

function sid(env: RunEnv): string {
  return env.conversation.terminalSessionId ?? env.conversation.id;
}

async function loop(env: RunEnv): Promise<void> {
  const { conversation, run, emit } = env;
  const mode = conversation.mode as AgentMode;
  const toolsEnabled = mode === "approval" || mode === "auto" || mode === "plan";
  let iterations = run.iterations;
  let providerId: string | null = null;
  try {
    const { adapter, config: pcfg } = await resolveProvider(conversation.orgId, env.ctx.user.id, conversation.providerId);
    providerId = pcfg.id;
    const model = conversation.model ?? pcfg.defaultModel;
    while (iterations < MAX_ITERATIONS) {
      if (env.signal?.aborted) {
        await finish(env, "cancelled");
        return;
      }
      iterations += 1;
      const built = await buildContext({
        orgId: conversation.orgId,
        workspaceId: conversation.workspaceId,
        userId: env.ctx.user.id,
        conversationId: conversation.id,
        mode,
        hostId: conversation.hostId,
        session: env.session,
        contextWindow: pcfg.contextWindow,
        reserveForOutput: pcfg.maxOutputTokens,
      });
      emit(envelope(sid(env), "agent.status", { runId: run.id, status: "thinking" }));
      const started = Date.now();
      let result: Awaited<ReturnType<typeof adapter.chat>> | null = null;
      try {
        for await (const ev of adapter.streamChat({ model, messages: built.messages, tools: toolsEnabled && env.session ? toolRegistry.definitions() : undefined, signal: env.signal })) {
          if (ev.type === "delta") emit(envelope(sid(env), "agent.delta", { runId: run.id, delta: ev.text }));
          else result = ev.result;
        }
        recordProviderOutcome(pcfg.id, true);
      } catch (err) {
        recordProviderOutcome(pcfg.id, false);
        throw err;
      }
      if (!result) throw new Error("Provider returned no result");
      await recordUsage({ orgId: conversation.orgId, workspaceId: conversation.workspaceId, userId: env.ctx.user.id, providerId: pcfg.id, model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, latencyMs: Date.now() - started, success: true, runId: run.id });
      await db.update(agentRuns).set({ iterations, inputTokens: run.inputTokens + result.usage.inputTokens, outputTokens: run.outputTokens + result.usage.outputTokens, providerId: pcfg.id, model }).where(eq(agentRuns.id, run.id));

      const [assistantRow] = await db
        .insert(agentMessages)
        .values({ orgId: conversation.orgId, conversationId: conversation.id, runId: run.id, role: "assistant", content: result.content, toolCalls: result.toolCalls.length ? result.toolCalls : null, tokenCount: result.usage.outputTokens })
        .returning({ id: agentMessages.id });
      emit(envelope(sid(env), "agent.message", { runId: run.id, messageId: assistantRow.id, content: result.content }));
      if (env.session && result.toolCalls.length) recordEvent(env.session, "ai_suggestion", JSON.stringify(redactObject(result.toolCalls)), false);

      if (!result.toolCalls.length) {
        await finish(env, "completed");
        return;
      }
      // Process tool calls sequentially; the first one needing approval pauses the run.
      for (const call of result.toolCalls) {
        const outcome = await handleToolCall(env, call, built.sources.length);
        if (outcome === "paused") return;
      }
    }
    await finish(env, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent run failed";
    await db.update(agentRuns).set({ status: "failed", error: message, endedAt: new Date() }).where(eq(agentRuns.id, run.id));
    emit(envelope(sid(env), "agent.status", { runId: run.id, status: "failed", error: message }));
    await audit({ actor: env.ctx, tenantId: conversation.orgId, workspaceId: conversation.workspaceId, resourceType: "agent_run", resourceId: run.id, action: "agent.run.failed", result: "failure", metadata: { error: message, providerId } });
  }
}

async function finish(env: RunEnv, status: "completed" | "cancelled") {
  await db.update(agentRuns).set({ status, endedAt: new Date() }).where(eq(agentRuns.id, env.run.id));
  env.emit(envelope(sid(env), "agent.status", { runId: env.run.id, status }));
  await audit({ actor: env.ctx, tenantId: env.conversation.orgId, workspaceId: env.conversation.workspaceId, resourceType: "agent_run", resourceId: env.run.id, action: `agent.run.${status}`, result: "success" });
}

export function evaluateTool(tool: ToolSpec, input: unknown, env: { environment: string; mode: AgentMode; ctx: AuthContext; orgId: string; workspaceId: string }): { risk: RiskLevel; decision: Decision; findings: Finding[]; command: string | null } {
  const command = tool.toCommand ? tool.toCommand(input as never) : null;
  const scope = { orgId: env.orgId, workspaceId: env.workspaceId };
  const permitted = hasPermission(env.ctx, scope, tool.permission, { environment: env.environment });
  if (!permitted) return { risk: tool.risk, decision: "blocked", findings: [{ code: "NO_PERMISSION", message: `Caller lacks ${tool.permission}`, risk: tool.risk }], command };
  if (env.environment === "production" && !tool.allowedInProduction) return { risk: tool.risk, decision: "blocked", findings: [{ code: "NOT_ALLOWED_IN_PRODUCTION", message: "Tool disabled for production hosts", risk: tool.risk }], command };
  if (command) {
    const res = decideCommand(command, {
      environment: env.environment,
      mode: env.mode,
      callerCanAutoExecute: hasPermission(env.ctx, scope, "agent:auto"),
      callerCanUseProduction: hasPermission(env.ctx, scope, "env:production"),
    });
    // The tool's declared risk is a floor; the command analysis can only raise it.
    const risk = ["R0", "R1", "R2", "R3", "R4"].indexOf(res.risk) >= ["R0", "R1", "R2", "R3", "R4"].indexOf(tool.risk) ? res.risk : tool.risk;
    let decision = res.decision;
    if (decision === "allow" && tool.requiresApproval && env.mode !== "auto") decision = "approval_required";
    if (decision === "approval_required" && !tool.requiresApproval && env.mode === "auto" && risk <= "R1" && env.environment !== "production") decision = "allow";
    return { risk, decision, findings: res.findings, command };
  }
  const decision: Decision = tool.requiresApproval && env.mode !== "auto" ? "approval_required" : "allow";
  return { risk: tool.risk, decision, findings: [], command };
}

async function handleToolCall(env: RunEnv, call: ToolCallRequest, _sources: number): Promise<"continued" | "paused"> {
  const { conversation, run, emit } = env;
  const tool = toolRegistry.get(call.name);
  const scope = { orgId: conversation.orgId, workspaceId: conversation.workspaceId };
  if (!tool) {
    await feedToolResult(env, call, { error: `Unknown tool '${call.name}'. Only registered tools may be used.` }, "blocked");
    await audit({ actor: env.ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "agent_tool_call", resourceId: call.id, action: "agent.tool.unknown", result: "denied", riskLevel: "R3", metadata: { tool: call.name } });
    return "continued";
  }
  const parsed = tool.input.safeParse(call.arguments);
  if (!parsed.success) {
    await feedToolResult(env, call, { error: "Invalid tool arguments", issues: parsed.error.issues.map((i) => i.message) }, "failed");
    return "continued";
  }
  if (!env.session) {
    await feedToolResult(env, call, { error: "No active terminal session is attached to this conversation." }, "failed");
    return "continued";
  }
  const evaluation = evaluateTool(tool, parsed.data, { environment: env.environment, mode: conversation.mode as AgentMode, ctx: env.ctx, orgId: scope.orgId, workspaceId: scope.workspaceId });
  const [tc] = await db
    .insert(agentToolCalls)
    .values({ orgId: scope.orgId, runId: run.id, conversationId: conversation.id, providerCallId: call.id, toolName: tool.name, input: parsed.data as Record<string, unknown>, riskLevel: evaluation.risk, decision: evaluation.decision, policyFindings: evaluation.findings, status: evaluation.decision === "blocked" ? "blocked" : "pending" })
    .returning();
  emit(envelope(sid(env), "agent.tool.request", { runId: run.id, toolCallId: tc.id, tool: tool.name, input: parsed.data, risk: evaluation.risk, decision: evaluation.decision, findings: evaluation.findings }));
  await audit({ actor: env.ctx, tenantId: scope.orgId, workspaceId: scope.workspaceId, resourceType: "agent_tool_call", resourceId: tc.id, action: "agent.tool.requested", result: evaluation.decision === "blocked" ? "denied" : "success", riskLevel: evaluation.risk, sessionId: conversation.terminalSessionId, metadata: { tool: tool.name, input: pickAudit(tool, parsed.data), decision: evaluation.decision, findings: evaluation.findings.map((f) => f.code) } });

  if (evaluation.decision === "blocked") {
    await feedToolResult(env, call, { error: "Blocked by policy", risk: evaluation.risk, findings: evaluation.findings }, "blocked", tc.id);
    return "continued";
  }
  if (evaluation.decision === "approval_required") {
    const [approval] = await db
      .insert(approvals)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        requestedBy: env.ctx.user.id,
        toolCallId: tc.id,
        hostId: conversation.hostId,
        terminalSessionId: conversation.terminalSessionId,
        kind: "tool_call",
        summary: evaluation.command ? `Run: ${evaluation.command}` : `Call ${tool.name}`,
        details: { tool: tool.name, input: parsed.data, command: evaluation.command, environment: env.environment, findings: evaluation.findings, runId: run.id, conversationId: conversation.id, user: env.ctx.user.email, rollback: rollbackHint(evaluation.command) },
        riskLevel: evaluation.risk,
        expiresAt: new Date(Date.now() + config.approvalTtlSeconds() * 1000),
      })
      .returning();
    await db.update(agentRuns).set({ status: "waiting_approval" }).where(eq(agentRuns.id, run.id));
    emit(envelope(sid(env), "approval.required", { runId: run.id, approvalId: approval.id, toolCallId: tc.id, summary: approval.summary, details: approval.details as Record<string, unknown>, risk: evaluation.risk }));
    emit(envelope(sid(env), "agent.status", { runId: run.id, status: "waiting_approval" }));
    return "paused";
  }
  await executeToolCall(env, tc.id, call, tool, parsed.data);
  return "continued";
}

function rollbackHint(command: string | null): string {
  if (!command) return "n/a";
  if (/^(systemctl|service)\s+(restart|stop|start)/.test(command)) return "Re-run with the opposite verb (start/stop) or restart the unit; check journalctl for state.";
  if (/^rm\b/.test(command)) return "Deletion is irreversible unless a backup/snapshot exists. Verify backups first.";
  if (/^(apt|yum|dnf|apk)\b/.test(command)) return "Reinstall/remove the affected package to the previous version.";
  return "Read-only or low-impact command; no rollback required.";
}

function pickAudit(tool: ToolSpec, input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = (input ?? {}) as Record<string, unknown>;
  for (const f of tool.auditFields) if (f in obj) out[f] = obj[f];
  return out;
}

async function executeToolCall(env: RunEnv, toolCallId: string, call: ToolCallRequest, tool: ToolSpec, input: unknown) {
  const { conversation, emit } = env;
  if (!env.session) return;
  const started = Date.now();
  try {
    if (env.session) recordEvent(env.session, "ai_exec", JSON.stringify({ tool: tool.name, input: pickAudit(tool, input) }), false);
    const output = await tool.execute(input as never, { session: env.session, environment: env.environment });
    await db.update(agentToolCalls).set({ status: "executed", output, durationMs: Date.now() - started, completedAt: new Date() }).where(eq(agentToolCalls.id, toolCallId));
    emit(envelope(sid(env), "agent.tool.result", { runId: env.run.id, toolCallId, output, status: "executed" }));
    await audit({ actor: env.ctx, tenantId: conversation.orgId, workspaceId: conversation.workspaceId, resourceType: "agent_tool_call", resourceId: toolCallId, action: "agent.tool.executed", result: "success", riskLevel: tool.risk, sessionId: conversation.terminalSessionId, metadata: { tool: tool.name, durationMs: Date.now() - started, exitCode: (output as { exitCode?: unknown }).exitCode ?? null } });
    await feedToolResult(env, call, output, "executed", toolCallId, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    await db.update(agentToolCalls).set({ status: "failed", output: { error: message }, durationMs: Date.now() - started, completedAt: new Date() }).where(eq(agentToolCalls.id, toolCallId));
    emit(envelope(sid(env), "agent.tool.result", { runId: env.run.id, toolCallId, output: { error: message }, status: "failed" }));
    await audit({ actor: env.ctx, tenantId: conversation.orgId, workspaceId: conversation.workspaceId, resourceType: "agent_tool_call", resourceId: toolCallId, action: "agent.tool.failed", result: "failure", metadata: { tool: tool.name, error: message } });
    await feedToolResult(env, call, { error: message }, "failed", toolCallId, false);
  }
}

async function feedToolResult(env: RunEnv, call: ToolCallRequest, output: unknown, status: string, toolCallId?: string, updateRow = true) {
  const content = JSON.stringify(redactObject(output)).slice(0, 48 * 1024);
  await db.insert(agentMessages).values({ orgId: env.conversation.orgId, conversationId: env.conversation.id, runId: env.run.id, role: "tool", content, toolCallId: call.id, toolCalls: { name: call.name, status } });
  if (toolCallId && updateRow) await db.update(agentToolCalls).set({ status, output: output as Record<string, unknown>, completedAt: new Date() }).where(eq(agentToolCalls.id, toolCallId));
  if (toolCallId && status !== "executed") env.emit(envelope(sid(env), "agent.tool.result", { runId: env.run.id, toolCallId, output, status }));
}

/**
 * Called by the approvals API after a human decision. Executes (or rejects)
 * the pending tool call and then continues the run.
 */
export async function applyApprovalDecision(ctx: AuthContext, approvalId: string, decision: "approved" | "rejected", note: string | undefined, emit: Emit, signal?: AbortSignal) {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval || !approval.toolCallId) throw new Error("Approval not found");
  if (approval.status !== "pending") throw new Error(`Approval already ${approval.status}`);
  if (approval.expiresAt < new Date()) {
    await db.update(approvals).set({ status: "expired", updatedAt: new Date() }).where(eq(approvals.id, approvalId));
    throw new Error("Approval has expired");
  }
  const [tc] = await db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, approval.toolCallId), eq(agentToolCalls.orgId, approval.orgId))).limit(1);
  if (!tc) throw new Error("Tool call not found");
  await db.update(approvals).set({ status: decision, decidedBy: ctx.user.id, decidedAt: new Date(), decisionNote: note ?? null, updatedAt: new Date() }).where(eq(approvals.id, approvalId));
  await audit({ actor: ctx, tenantId: approval.orgId, workspaceId: approval.workspaceId, resourceType: "approval", resourceId: approvalId, action: `approval.${decision}`, result: "success", riskLevel: approval.riskLevel as RiskLevel, sessionId: approval.terminalSessionId, metadata: { tool: tc.toolName, summary: approval.summary, note } });

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, tc.runId)).limit(1);
  if (!run) throw new Error("Run not found");
  const env = await loadEnv(ctx, run.conversationId, emit, signal, run.id);
  emit(envelope(sid(env), "approval.result", { approvalId, status: decision }));
  if (env.session) recordEvent(env.session, "approval", JSON.stringify({ approvalId, decision, tool: tc.toolName }), false);
  const call: ToolCallRequest = { id: tc.providerCallId, name: tc.toolName, arguments: tc.input as Record<string, unknown> };
  const tool = toolRegistry.get(tc.toolName);
  if (decision === "rejected" || !tool) {
    await db.update(agentToolCalls).set({ status: "rejected", completedAt: new Date() }).where(eq(agentToolCalls.id, tc.id));
    await feedToolResult(env, call, { error: `The user rejected this action${note ? `: ${note}` : ""}. Do not retry it; propose an alternative or stop.` }, "rejected", tc.id, false);
  } else {
    await db.update(agentToolCalls).set({ status: "approved" }).where(eq(agentToolCalls.id, tc.id));
    await executeToolCall(env, tc.id, call, tool, tc.input);
  }
  await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, run.id));
  await loop({ ...env, run: { ...run, status: "running" } });
}


