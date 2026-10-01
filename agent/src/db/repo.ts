/** Conversation repository: linear message history with truncate (edit = inclusive, rewind = exclusive). */
import { and, asc, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import type { Role } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { db as defaultDb, type DB } from "./client.js";
import { conversations, messages, type ConversationRow } from "./schema.js";

export interface Conversation {
  id: string;
  role: Role;
  facility_id: number | null;
  title: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
  message_count?: number;
  last_message_preview?: string | null;
}

export type StoredMessage = Pick<UIMessage, "id" | "role" | "parts" | "metadata">;

const now = () => new Date().toISOString();

function toConversation(r: ConversationRow, extra: Partial<Conversation> = {}): Conversation {
  return {
    id: r.id, role: r.role as Role, facility_id: r.facilityId ?? null, title: r.title, created_at: r.createdAt,
    updated_at: r.updatedAt, run_id: r.runId ?? null, ...extra,
  };
}

/** First user text, trimmed to a title. */
export function titleFrom(msg: Pick<UIMessage, "parts"> | undefined): string {
  const text = (msg?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "New conversation";
  return text.length > 72 ? `${text.slice(0, 69).trimEnd()}...` : text;
}

export function textOf(msg: Pick<UIMessage, "parts"> | undefined): string {
  return (msg?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("").trim();
}

export class ConversationRepo {
  constructor(private getDb: () => Promise<DB> = defaultDb) {}

  async create(input: { id?: string; role: Role; facilityId: number | null; title?: string; runId?: string | null }): Promise<Conversation> {
    const d = await this.getDb();
    const t = now();
    const row = {
      id: input.id ?? randomUUID(), role: input.role, facilityId: input.facilityId, title: input.title?.trim() || "New conversation",
      createdAt: t, updatedAt: t, runId: input.runId ?? null,
    };
    await d.insert(conversations).values(row);
    return toConversation(row as ConversationRow, { message_count: 0, last_message_preview: null });
  }

  async get(id: string): Promise<Conversation | null> {
    const d = await this.getDb();
    const r = await d.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return r[0] ? toConversation(r[0]) : null;
  }

  /** 404 when missing, 403 when the conversation is pinned to another role / facility (plan B2). */
  async getFor(id: string, role: Role, facilityId: number | null): Promise<Conversation> {
    const c = await this.get(id);
    if (!c) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
    if (c.role !== role || (role === "doctor" && c.facility_id !== facilityId)) {
      throw new ApiError(403, "FORBIDDEN", "This conversation belongs to another role or facility", {
        conversation_role: c.role, conversation_facility_id: c.facility_id,
      });
    }
    return c;
  }

  async list(filter: { role: Role; facilityId: number | null; limit?: number }): Promise<Conversation[]> {
    const d = await this.getDb();
    const where = filter.role === "doctor"
      ? and(eq(conversations.role, "doctor"), filter.facilityId === null ? isNull(conversations.facilityId) : eq(conversations.facilityId, filter.facilityId))
      : eq(conversations.role, filter.role);
    const rows = await d
      .select({
        c: conversations,
        n: sql<number>`(SELECT count(*) FROM messages m WHERE m.conversation_id = "conversations"."id")`,
        last: sql<string | null>`(SELECT m.parts FROM messages m WHERE m.conversation_id = "conversations"."id" ORDER BY m.seq DESC LIMIT 1)`,
      })
      .from(conversations)
      .where(where)
      .orderBy(desc(conversations.updatedAt))
      .limit(filter.limit ?? 200);
    return rows.map((r) => {
      let preview: string | null = null;
      try {
        preview = r.last ? textOf({ parts: JSON.parse(r.last) }).slice(0, 140) || null : null;
      } catch {
        preview = null;
      }
      return toConversation(r.c, { message_count: Number(r.n), last_message_preview: preview });
    });
  }

  async update(id: string, patch: { title?: string; runId?: string | null }): Promise<Conversation | null> {
    const d = await this.getDb();
    const set: Partial<ConversationRow> = { updatedAt: now() };
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200) || "New conversation";
    if (patch.runId !== undefined) set.runId = patch.runId;
    await d.update(conversations).set(set).where(eq(conversations.id, id));
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const d = await this.getDb();
    await d.delete(messages).where(eq(messages.conversationId, id));
    const r = await d.delete(conversations).where(eq(conversations.id, id)).returning({ id: conversations.id });
    return r.length > 0;
  }

  async messages(conversationId: string): Promise<StoredMessage[]> {
    const d = await this.getDb();
    const rows = await d.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.seq));
    return rows.map((r) => ({
      id: r.id, role: r.role as UIMessage["role"], parts: r.parts as UIMessage["parts"],
      ...(r.metadata ? { metadata: r.metadata } : {}),
    }));
  }

  async getMessage(conversationId: string, messageId: string) {
    const d = await this.getDb();
    const r = await d.select().from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId))).limit(1);
    return r[0] ?? null;
  }

  /** Appends at the end of the history, or replaces in place when a message with that id already exists. */
  async upsertMessage(conversationId: string, msg: StoredMessage): Promise<void> {
    const d = await this.getDb();
    const existing = await this.getMessage(conversationId, msg.id);
    if (existing) {
      await d.update(messages).set({ parts: msg.parts, metadata: (msg.metadata ?? null) as never, role: msg.role })
        .where(eq(messages.id, msg.id));
    } else {
      const other = await d.select({ id: messages.id, cid: messages.conversationId }).from(messages).where(eq(messages.id, msg.id)).limit(1);
      if (other[0]) throw new ApiError(409, "CONFLICT", "Message id already used in another conversation");
      const max = await d.select({ m: sql<number | null>`max(${messages.seq})` }).from(messages).where(eq(messages.conversationId, conversationId));
      await d.insert(messages).values({
        id: msg.id, conversationId, seq: (max[0]?.m ?? -1) + 1, role: msg.role, parts: msg.parts,
        metadata: (msg.metadata ?? null) as never, createdAt: now(),
      });
    }
    await d.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, conversationId));
  }

  /**
   * Linear rewind: removes every message after `messageId` (inclusive = also the message itself).
   * Edit = truncate inclusive then send the edited message; rewind = truncate exclusive.
   */
  async truncate(conversationId: string, messageId: string, inclusive: boolean): Promise<number> {
    const d = await this.getDb();
    const target = await this.getMessage(conversationId, messageId);
    if (!target) throw new ApiError(404, "NOT_FOUND", "Message not found in this conversation");
    const cond = inclusive ? gte(messages.seq, target.seq) : gt(messages.seq, target.seq);
    const r = await d.delete(messages).where(and(eq(messages.conversationId, conversationId), cond)).returning({ id: messages.id });
    await d.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, conversationId));
    return r.length;
  }

  /** Drops trailing assistant messages (regenerate without an explicit message id). */
  async dropTrailingAssistant(conversationId: string): Promise<number> {
    const msgs = await this.messages(conversationId);
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role === "assistant") i--;
    if (i === msgs.length - 1) return 0;
    if (i < 0) {
      const d = await this.getDb();
      const r = await d.delete(messages).where(eq(messages.conversationId, conversationId)).returning({ id: messages.id });
      return r.length;
    }
    return this.truncate(conversationId, msgs[i].id, false);
  }
}

let repo: ConversationRepo | null = null;
export function conversationsRepo(): ConversationRepo {
  if (!repo) repo = new ConversationRepo();
  return repo;
}
export function setConversationsRepo(r: ConversationRepo | null): void {
  repo = r;
}
