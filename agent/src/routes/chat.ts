/**
 * POST /agent/chat           AI SDK UI-message stream (SSE) for useChat; persists the user + assistant messages.
 * POST /agent/chat/complete  same turn, non-streaming JSON (evals, MCP, scripts).
 */
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { completeTurn, startTurn, summarise, type AgentUIMessage } from "../agents/run.js";
import type { AgentContext } from "../context.js";
import { conversationsRepo, titleFrom } from "../db/repo.js";
import { ApiError } from "../lib/errors.js";
import type { Env } from "../lib/hono.js";

const UIMessageIn = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.record(z.string(), z.unknown())).max(200),
  metadata: z.unknown().optional(),
});

const ChatBody = z.object({
  id: z.string().min(1).max(200).describe("conversation id (useChat id)"),
  message: UIMessageIn.optional().describe("the new / edited user message (preferred: send only the last message)"),
  messages: z.array(UIMessageIn).max(400).optional().describe("full history as sent by the default transport; the last one is used"),
  trigger: z.enum(["submit-message", "regenerate-message"]).default("submit-message"),
  messageId: z.string().optional().describe("regenerate: the assistant message to replace"),
});

const CompleteBody = z.object({
  question: z.string().min(1).max(4000).optional(),
  messages: z.array(UIMessageIn).max(400).optional(),
  conversation_id: z.string().max(200).optional(),
  persist: z.boolean().optional().describe("default: true when conversation_id is given"),
  title: z.string().max(200).optional(),
});

function userMessage(text: string, id?: string): AgentUIMessage {
  return { id: id ?? `msg_u_${crypto.randomUUID().slice(0, 12)}`, role: "user", parts: [{ type: "text", text }] };
}

/** Loads / creates the conversation and applies the trigger (append, edit-in-place, regenerate) to the stored history. */
export async function prepareHistory(ctx: AgentContext, body: z.infer<typeof ChatBody>): Promise<AgentUIMessage[]> {
  const repo = conversationsRepo();
  const incoming = (body.message ?? body.messages?.at(-1)) as AgentUIMessage | undefined;
  let conv = await repo.get(body.id);
  if (conv) conv = await repo.getFor(body.id, ctx.role, ctx.facilityId);
  else conv = await repo.create({ id: body.id, role: ctx.role, facilityId: ctx.facilityId, title: titleFrom(incoming) });

  if (body.trigger === "regenerate-message") {
    const target = body.messageId ? await repo.getMessage(conv.id, body.messageId) : null;
    if (target) await repo.truncate(conv.id, target.id, target.role === "assistant");
    else await repo.dropTrailingAssistant(conv.id);
    if (incoming?.role === "user" && !(await repo.getMessage(conv.id, incoming.id))) await repo.upsertMessage(conv.id, incoming);
  } else {
    if (!incoming || incoming.role !== "user") throw new ApiError(400, "INVALID_MESSAGE", "submit-message needs a user message");
    const existing = await repo.getMessage(conv.id, incoming.id);
    const before = await repo.messages(conv.id);
    // The title follows the first user message unless it was renamed: retitle when this message becomes (or replaces)
    // the first message and the title is still "New conversation" or the auto title of the message it replaces.
    const replacesAutoTitledFirst = !!existing && before[0]?.id === existing.id && conv.title === titleFrom(existing as never);
    if (existing) await repo.truncate(conv.id, incoming.id, false); // edited in place: drop everything after it
    await repo.upsertMessage(conv.id, { id: incoming.id, role: "user", parts: incoming.parts, metadata: incoming.metadata });
    if (conv.title === "New conversation" || replacesAutoTitledFirst) await repo.update(conv.id, { title: titleFrom(incoming) });
  }
  const history = (await repo.messages(conv.id)) as AgentUIMessage[];
  if (!history.length || history.at(-1)!.role !== "user") {
    throw new ApiError(409, "NOTHING_TO_ANSWER", "The conversation does not end with a user message");
  }
  return history;
}

export const chatRoutes = new Hono<Env>();

chatRoutes.post("/chat", async (c) => {
  const ctx = c.get("ctx");
  const body = ChatBody.parse(await c.req.json());
  const history = await prepareHistory(ctx, body);
  const repo = conversationsRepo();
  const turn = await startTurn({
    ctx, history, abortSignal: c.req.raw.signal,
    onFinished: async (msg) => {
      await repo.upsertMessage(body.id, msg as UIMessage);
      const meta = msg.metadata;
      if (meta?.run_id !== undefined) await repo.update(body.id, { runId: meta.run_id === null ? null : String(meta.run_id) });
    },
  });
  turn.finished.catch((e) => console.error("[agent] persist failed:", e));
  return createUIMessageStreamResponse({ stream: turn.stream, headers: { "X-Conversation-Id": body.id }, keepAliveMs: 15_000 } as never);
});

chatRoutes.post("/chat/complete", async (c) => {
  const ctx = c.get("ctx");
  const body = CompleteBody.parse(await c.req.json());
  const t0 = Date.now();
  let history: AgentUIMessage[];
  let conversationId: string | null = null;
  const persist = body.persist ?? !!body.conversation_id;
  if (body.conversation_id && persist) {
    conversationId = body.conversation_id;
    const msg = body.messages?.at(-1) ?? (body.question ? userMessage(body.question) : undefined);
    history = await prepareHistory(ctx, { id: conversationId, message: msg as never, trigger: "submit-message" });
  } else {
    history = (body.messages as AgentUIMessage[] | undefined) ?? [];
    if (body.question) history = [...history, userMessage(body.question)];
    if (!history.length || history.at(-1)!.role !== "user") throw new ApiError(400, "INVALID_REQUEST", "Pass question or messages ending with a user message");
  }
  const repo = conversationsRepo();
  const { message, tctx } = await completeTurn({
    ctx, history, abortSignal: c.req.raw.signal,
    onFinished: conversationId ? async (msg) => repo.upsertMessage(conversationId!, msg as UIMessage) : undefined,
  });
  const s = summarise(message, tctx);
  return c.json({
    data: {
      conversation_id: conversationId,
      role: ctx.role,
      facility_id: ctx.facilityId,
      answer: s.answer,
      tool_calls: s.tool_calls,
      widgets: s.widgets,
      retrieval_context: s.retrieval_context,
      validated_numbers: message.metadata?.validated_numbers ?? null,
      unsupported_numbers: message.metadata?.unsupported_numbers ?? [],
      metadata: message.metadata ?? null,
      message,
      latency_ms: Date.now() - t0,
    },
  });
});
