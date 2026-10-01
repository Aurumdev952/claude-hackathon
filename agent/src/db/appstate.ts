/** Read-only view of the FastAPI's writable state (data/analytics/app_state.sqlite): alert status overlay (api/app_state.py). */
import { existsSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { config } from "../config.js";

export interface AlertStatus {
  status: string;
  note: string | null;
  reason: string | null;
  updated_at: string | null;
}

let client: Client | null = null;
let clientPath: string | null = null;

function get(): Client | null {
  const p = config().appStatePath;
  if (!existsSync(p)) return null;
  if (!client || clientPath !== p) {
    client = createClient({ url: `file:${p}` });
    clientPath = p;
  }
  return client;
}

export async function alertStatuses(ids: string[]): Promise<Record<string, AlertStatus>> {
  const c = get();
  if (!c || !ids.length) return {};
  try {
    const out: Record<string, AlertStatus> = {};
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await c.execute({
        sql: `SELECT alert_id, status, note, reason, updated_at FROM alert_status WHERE alert_id IN (${chunk.map(() => "?").join(",")})`,
        args: chunk,
      });
      for (const row of r.rows) {
        out[String(row.alert_id)] = {
          status: String(row.status), note: (row.note as string | null) ?? null, reason: (row.reason as string | null) ?? null,
          updated_at: (row.updated_at as string | null) ?? null,
        };
      }
    }
    return out;
  } catch {
    return {}; // table not created yet: no overlay
  }
}
