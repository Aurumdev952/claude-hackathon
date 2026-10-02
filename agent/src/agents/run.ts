/**
 * One agent turn: persona prompt + role tool set + history -> streamText. Shared by POST /agent/chat (SSE),
 * POST /agent/chat/complete (JSON) and the MCP `ask_early_signals_agent` tool.
 */
import {
  convertToModelMessages,
  createIdGenerator,
  stepCountIs,
  streamText,
  type StepResult,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { config } from "../config.js";
import type { AgentContext } from "../context.js";
import { SERVE } from "../db/duck.js";
import { collectNumbers, unsupportedNumbers } from "../guardrails/numbers.js";
import { describeModel, languageModel } from "../llm/model.js";
import { buildTools, modelSafe, toolDefsFor } from "../tools/index.js";
import { MAX_PYTHON_RUNS_PER_TURN } from "../tools/run_python.js";
import { newToolCtx, type ToolCtx } from "../tools/types.js";
import type { MessageMetadata } from "../widgets/specs.js";
import { doctorSystem } from "./doctor.js";
import { ministrySystem } from "./ministry.js";
import { CHART_INTENT, PATIENT_INTENT, PYTHON_INTENT } from "./shared.js";

export type AgentUIMessage = UIMessage<MessageMetadata>;

export const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });

const DATA_TOOLS = new Set([
  "get_kpis", "get_rates_trend", "get_district_ranking", "get_care_cascade", "get_stage_mix", "get_survival",
  "get_facility_quality", "get_model_metrics", "query_marts", "list_high_risk_patients", "get_patient_risk",
  "get_care_funnel", "get_forecast", "run_forecast_scenario", "get_model_monitoring", "list_followups", "get_patient_journey",
]);

export async function systemPrompt(ctx: AgentContext): Promise<string> {
  const db = SERVE();
  await db.refresh();
  const meta = db.meta();
  if (ctx.role === "doctor") {
    let name: string | null = null;
    try {
      name = ((await db.one("SELECT name FROM core_dim_location WHERE location_id = ?", [ctx.facilityId]))?.name as string) ?? null;
    } catch {
      name = null;
    }
    return doctorSystem(meta, { id: ctx.facilityId, name });
  }
  return ministrySystem(meta);
}

function lastUserText(messages: UIMessage[]): string {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return (u?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

type AnyStep = StepResult<ToolSet>;

function calledTools(steps: AnyStep[]): string[] {
  return steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
}

/**
 * Nudges tool choice: after a data tool returned rows for a chart-worthy question, the next step must call make_chart;
 * a doctor question about one patient must reach make_patient_widget once the patient is known. Questions that ask for
 * Python / matplotlib / plotly are never forced to make_chart (run_python stays available). run_python is removed from
 * the active tools after the per-turn limit.
 */
export function prepareStepFor(ctx: AgentContext, question: string, tctx: ToolCtx) {
  const wantsChart = CHART_INTENT.test(question) && !PYTHON_INTENT.test(question);
  const wantsPatient = ctx.role === "doctor" && PATIENT_INTENT.test(question);
  const names = toolDefsFor(ctx.role).map((d) => d.name);
  return ({ steps }: { steps: AnyStep[] }) => {
    const called = calledTools(steps);
    const last = steps.at(-1);
    const lastData = (last?.toolResults ?? []).some((r) => DATA_TOOLS.has(r.toolName) && (r.output as { ok?: boolean })?.ok !== false);
    const activeTools = tctx.pythonRuns >= MAX_PYTHON_RUNS_PER_TURN ? names.filter((n) => n !== "run_python") : undefined;
    if (wantsPatient && !called.includes("make_patient_widget")) {
      const found = (last?.toolResults ?? []).some((r) =>
        ["list_high_risk_patients", "get_patient", "get_patient_risk", "list_alerts"].includes(r.toolName) && (r.output as { ok?: boolean })?.ok !== false);
      if (found) return { toolChoice: { type: "tool" as const, toolName: "make_patient_widget" }, ...(activeTools ? { activeTools } : {}) };
    }
    if (wantsChart && lastData && !called.includes("make_chart") && !(wantsPatient && !called.includes("make_patient_widget"))) {
      return { toolChoice: { type: "tool" as const, toolName: "make_chart" }, ...(activeTools ? { activeTools } : {}) };
    }
    return activeTools ? { activeTools } : {};
  };
}

/** Some models HTML-escape tool arguments ("&lt;50" for "<50"); unescape and let the SDK re-validate once. */
export function unescapeToolInput(input: string): string {
  return input.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function repairToolCall({ toolCall }: { toolCall: { input: string } }) {
  const fixed = unescapeToolInput(toolCall.input);
  return fixed !== toolCall.input ? { ...toolCall, input: fixed } : null;
}

export interface TurnOptions {
  ctx: AgentContext;
  /** Full linear history ending with the user message to answer. */
  history: AgentUIMessage[];
  surface?: ToolCtx["surface"];
  abortSignal?: AbortSignal;
  onFinished?: (message: AgentUIMessage) => Promise<void> | void;
}

export interface Turn {
  stream: ReadableStream<UIMessageChunk>;
  finished: Promise<AgentUIMessage>;
  tctx: ToolCtx;
  tools: ToolSet;
}

/** Numbers in the answer that no tool output (this turn or earlier turns) supports. */
export function numberCheck(text: string, messages: UIMessage[], tctx: ToolCtx) {
  const pool: number[] = [];
  const defs = new Map(toolDefsFor(tctx.ctx.role).map((d) => [d.name, d]));
  for (const m of messages) {
    for (const p of m.parts) {
      if (!p.type.startsWith("tool-")) continue;
      const tp = p as { state?: string; output?: unknown; input?: unknown };
      if (tp.state !== "output-available") continue;
      const def = defs.get(p.type.slice(5) as never);
      collectNumbers(def ? modelSafe(def, tp.output, tctx) : tp.output, pool);
      collectNumbers(tp.output, pool);
    }
  }
  const bad = unsupportedNumbers(text, pool);
  return { validated: bad.length === 0, unsupported: bad };
}

export async function startTurn(o: TurnOptions): Promise<Turn> {
  const cfg = config();
  const tctx = newToolCtx(o.ctx, o.surface ?? "chat");
  for (const m of o.history) tctx.datasets.loadFromParts(m.parts as never);
  const tools = buildTools(tctx);
  const system = await systemPrompt(o.ctx);
  const meta = SERVE().meta();
  const modelInfo = describeModel(cfg);
  const startedAt = new Date().toISOString();
  const messages = await convertToModelMessages(o.history, { tools, ignoreIncompleteToolCalls: true });
  const question = lastUserText(o.history);

  const result = streamText({
    model: languageModel(),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(cfg.maxSteps),
    prepareStep: prepareStepFor(o.ctx, question, tctx) as never,
    repairToolCall,
    temperature: 0.2,
    maxRetries: 2,
    abortSignal: o.abortSignal,
    timeout: 180_000,
    providerOptions: { openrouter: { usage: { include: true } } },
  } as never) as ReturnType<typeof streamText>;

  let resolveDone!: (m: AgentUIMessage) => void;
  let rejectDone!: (e: unknown) => void;
  const finished = new Promise<AgentUIMessage>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const stream = result.toUIMessageStream<AgentUIMessage>({
    originalMessages: o.history,
    generateMessageId,
    sendReasoning: true,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return {
          run_id: meta.run_id, sim_time: meta.sim_time, model: modelInfo.model, role: o.ctx.role, facility_id: o.ctx.facilityId,
          created_at: startedAt,
        };
      }
      if (part.type === "finish") {
        const u = (part as { totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).totalUsage;
        return {
          finished_at: new Date().toISOString(),
          finish_reason: (part as { finishReason?: string }).finishReason,
          usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens } : undefined,
        };
      }
      return undefined;
    },
    onError: (e) => {
      console.error("[agent] stream error:", e);
      const msg = String((e as Error)?.message ?? e);
      return /api key|401|unauthor/i.test(msg) ? "The language model rejected the request (check OPENROUTER_API_KEY / AGENT_MODEL)." : `Agent error: ${msg.slice(0, 300)}`;
    },
    onEnd: async ({ responseMessage, messages: all }) => {
      try {
        const text = responseMessage.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
        const check = numberCheck(text, all, tctx);
        const tools_called = responseMessage.parts.filter((p) => p.type.startsWith("tool-")).map((p) => p.type.slice(5));
        responseMessage.metadata = {
          ...(responseMessage.metadata ?? {}),
          run_id: meta.run_id, sim_time: meta.sim_time, model: modelInfo.model, role: o.ctx.role, facility_id: o.ctx.facilityId,
          created_at: (responseMessage.metadata as MessageMetadata | undefined)?.created_at ?? startedAt,
          validated_numbers: check.validated, unsupported_numbers: check.unsupported, tools_called,
        };
        await o.onFinished?.(responseMessage);
        resolveDone(responseMessage);
      } catch (e) {
        rejectDone(e);
      }
    },
  });
  return { stream, finished, tctx, tools };
}

/** Runs a turn to completion (non-streaming): used by /agent/chat/complete and MCP. */
export async function completeTurn(o: TurnOptions): Promise<{ message: AgentUIMessage; tctx: ToolCtx }> {
  const turn = await startTurn(o);
  const reader = turn.stream.getReader();
  const errors: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.type === "error") errors.push((value as { errorText: string }).errorText);
  }
  const message = await Promise.race([
    turn.finished,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(errors.join("; ") || "turn did not finish")), 5000)),
  ]);
  if (errors.length && !message.parts.some((p) => p.type === "text" && p.text.trim())) {
    message.parts.push({ type: "text", text: errors.join("\n") });
  }
  return { message, tctx: turn.tctx };
}

/** Compact, model-safe summary of a finished assistant message (evals, MCP). */
export function summarise(message: AgentUIMessage, tctx: ToolCtx) {
  const defs = new Map(toolDefsFor(tctx.ctx.role).map((d) => [d.name, d]));
  const tool_calls = [];
  const widgets = [];
  for (const p of message.parts) {
    if (!p.type.startsWith("tool-")) continue;
    const tp = p as { toolCallId: string; state: string; input?: unknown; output?: unknown; errorText?: string };
    const name = p.type.slice(5);
    const def = defs.get(name as never);
    const safe = tp.state === "output-available" && def ? modelSafe(def, tp.output, tctx) : null;
    tool_calls.push({ name, state: tp.state, input: tp.input ?? null, output: safe, error: tp.errorText ?? null });
    const out = tp.output as { kind?: string } | undefined;
    if (out?.kind === "chart" || out?.kind === "artifact" || out?.kind === "video") widgets.push({ tool: name, ...(out as object) });
    if (out?.kind === "patient") widgets.push({ tool: name, ...(safe as object), kind: "patient" });
  }
  const answer = message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text.trim()).filter(Boolean).join("\n\n");
  return { answer, tool_calls, widgets, retrieval_context: tool_calls.filter((c) => c.output).map((c) => JSON.stringify(c.output)) };
}
