/** libsql client + Drizzle. The schema is created on startup (idempotent DDL mirrors src/db/schema.ts). */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type DB = LibSQLDatabase<typeof schema> & { $client: Client };

const DDL = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY, role TEXT NOT NULL, facility_id INTEGER, title TEXT NOT NULL DEFAULT 'New conversation',
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS conversations_role_idx ON conversations (role, facility_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
     role TEXT NOT NULL, parts TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages (conversation_id, seq)`,
];

export async function openDb(file = config().dbPath): Promise<DB> {
  const url = file === ":memory:" ? ":memory:" : `file:${file}`;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
  for (const sql of DDL) await client.execute(sql);
  return drizzle(client, { schema }) as DB;
}

let dbPromise: Promise<DB> | null = null;
export function db(): Promise<DB> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}
export function setDb(p: Promise<DB> | null): void {
  dbPromise = p;
}
