/** Tool definitions are plain objects shared by the AI SDK agents (tools/index.ts) and the MCP server (mcp/server.ts). */
import type { z } from "zod";
import type { AgentContext, Role } from "../context.js";
import type { RowObject } from "../db/duck.js";
import type { ToolName } from "../widgets/specs.js";

export interface Dataset {
  id: string;
  tool: string;
  columns: string[];
  rows: RowObject[];
  sql?: string | null;
}

/** Datasets returned by data tools (`dataset_id` + `rows`) so make_chart / run_python can reuse exact rows by reference. */
export class DatasetRegistry {
  private map = new Map<string, Dataset>();
  private n = 0;

  register(tool: string, rows: RowObject[], sql?: string | null): string {
    const id = `ds${++this.n}`;
    const columns = rows.length ? Object.keys(rows[0]) : [];
    this.map.set(id, { id, tool, columns, rows, sql: sql ?? null });
    return id;
  }

  get(id: string): Dataset | undefined {
    return this.map.get(id.trim());
  }

  /** Rebuild from persisted tool parts so follow-up turns can chart earlier results (nested datasets included). */
  loadFromParts(parts: { type: string; state?: string; output?: unknown }[]): void {
    for (const p of parts) {
      if (!p.type.startsWith("tool-") || p.state !== "output-available") continue;
      this.collect(p.type.slice(5), p.output, 0);
    }
  }

  private collect(tool: string, o: unknown, depth: number): void {
    if (!o || typeof o !== "object" || Array.isArray(o) || depth > 3) return;
    const r = o as { dataset_id?: unknown; rows?: unknown; sql_executed?: unknown };
    if (typeof r.dataset_id === "string" && Array.isArray(r.rows)) {
      const m = /^ds(\d+)$/.exec(r.dataset_id);
      if (m) this.n = Math.max(this.n, Number(m[1]));
      const rows = r.rows as RowObject[];
      this.map.set(r.dataset_id, {
        id: r.dataset_id, tool, columns: rows.length ? Object.keys(rows[0]) : [], rows,
        sql: typeof r.sql_executed === "string" ? r.sql_executed : null,
      });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v)) this.collect(tool, v, depth + 1);
  }

  ids(): string[] {
    return [...this.map.keys()];
  }
}

export interface ToolCtx {
  ctx: AgentContext;
  datasets: DatasetRegistry;
  /** chat = our own agents (UI gets full outputs); mcp = external agents (only the model-safe view leaves the server). */
  surface: "chat" | "mcp";
  pythonRuns: number;
}

export function newToolCtx(ctx: AgentContext, surface: ToolCtx["surface"] = "chat"): ToolCtx {
  return { ctx, datasets: new DatasetRegistry(), surface, pythonRuns: 0 };
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject, O = unknown> {
  name: ToolName;
  title: string;
  description: string;
  roles: Role[];
  inputSchema: S;
  execute(input: z.infer<S>, t: ToolCtx): Promise<O>;
  /** What the remote model (and MCP clients) see. The role filter (pseudonymise / de-identify) is applied on top. */
  modelView?(output: O, t: ToolCtx): unknown;
}

export function defineTool<S extends z.ZodObject, O>(def: ToolDef<S, O>): ToolDef<S, O> {
  return def;
}

export class ToolInputError extends Error {}
