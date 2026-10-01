/** Chat persistence (Drizzle + libsql/SQLite). Linear history: edit / rewind truncate after a message. */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    role: text("role", { enum: ["ministry", "doctor"] }).notNull(),
    facilityId: integer("facility_id"),
    title: text("title").notNull().default("New conversation"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    runId: text("run_id"),
  },
  (t) => [index("conversations_role_idx").on(t.role, t.facilityId, t.updatedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    /** UIMessage parts stored verbatim (tool outputs included) so widgets re-render on reload without re-running tools. */
    parts: text("parts", { mode: "json" }).notNull(),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("messages_conv_seq_idx").on(t.conversationId, t.seq)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
