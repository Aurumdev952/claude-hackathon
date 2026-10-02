/**
 * Read-only access to the published serve DuckDB (port of api/deps.py ServeDB).
 *
 * Follows <analytics>/current.json (blue/green publish, pipeline/publish.py) and swaps the instance when the active colour
 * or run_id changes. The instance is opened READ_ONLY with external access disabled, so even a query that slipped past
 * the guardrails could not read files, attach databases or write anything.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, DuckDBTypeId, type DuckDBConnection, type DuckDBResultReader } from "@duckdb/node-api";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type RowObject = Record<string, Json>;

export interface ServeMeta {
  run_id: number | string | null;
  sim_time: string | null;
  published_at: string | null;
  active?: string | null;
}

interface Current {
  active: string;
  run_id: number | string;
  published_at?: string;
  sim_time?: string;
  file?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function isoTimestamp(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return `${isoDate(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3)}000` : ""}`;
}

/** DuckDB JS values -> JSON-safe values with the same conventions as api/deps.py `_clean` (NaN/Inf -> null, ISO dates). */
export function toJson(v: unknown, typeId?: DuckDBTypeId): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return typeId === DuckDBTypeId.DATE ? isoDate(v) : isoTimestamp(v);
  }
  if (Array.isArray(v)) return v.map((x) => toJson(x));
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = toJson(x);
    return out;
  }
  return String(v);
}

export function readerRows(reader: DuckDBResultReader, max = Infinity): { columns: string[]; rows: RowObject[] } {
  const columns = reader.columnNames();
  const types = reader.columnTypes().map((t) => t.typeId);
  const raw = reader.getRowsJS();
  const rows: RowObject[] = [];
  for (let i = 0; i < raw.length && i < max; i++) {
    const r: RowObject = {};
    const vals = raw[i];
    for (let j = 0; j < columns.length; j++) r[columns[j]] = toJson(vals[j], types[j]);
    rows.push(r);
  }
  return { columns, rows };
}

export class QueryTimeout extends Error {}

export class ServeDB {
  private instance: DuckDBInstance | null = null;
  private current: Current | null = null;
  private filePath: string | null = null;
  private cache = new Map<string, unknown>();
  private tableSet: Set<string> | null = null;
  private columnsByTable: Map<string, string[]> | null = null;
  private lastCheck = 0;
  private opening: Promise<boolean> | null = null;

  constructor(private opts: { analyticsDir?: string; file?: string } = {}) {}

  get ready(): boolean {
    return this.instance !== null;
  }

  meta(): ServeMeta {
    const c = this.current;
    return { run_id: c?.run_id ?? null, sim_time: c?.sim_time ?? null, published_at: c?.published_at ?? null, active: c?.active ?? null };
  }

  get path(): string | null {
    return this.filePath;
  }

  /** Re-reads current.json (at most every 2 s) and swaps to the new serve file after a publish. */
  async refresh(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && this.instance && now - this.lastCheck < 2000) return false;
    this.lastCheck = now;
    if (this.opening) return this.opening;
    this.opening = this.doRefresh().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doRefresh(): Promise<boolean> {
    let file: string;
    let cur: Current;
    const explicit = this.opts.file ?? (this.opts.analyticsDir ? undefined : config().serveDbPath);
    if (explicit) {
      if (this.instance && this.filePath === explicit) return false;
      if (!existsSync(explicit)) return false;
      file = explicit;
      cur = { active: "fixture", run_id: 0, sim_time: undefined, published_at: undefined, file: path.basename(explicit) };
      try {
        cur = { ...cur, ...JSON.parse(readFileSync(explicit + ".meta.json", "utf8")) };
      } catch {
        /* fixture without a meta file */
      }
    } else {
      const dir = this.opts.analyticsDir ?? config().analyticsDir;
      try {
        cur = JSON.parse(readFileSync(path.join(dir, "current.json"), "utf8")) as Current;
      } catch {
        return false;
      }
      if (this.current && cur.run_id === this.current.run_id && cur.active === this.current.active) return false;
      file = path.join(dir, `serve_${cur.active}.duckdb`);
      if (!existsSync(file)) return false;
    }
    const inst = await DuckDBInstance.create(file, {
      access_mode: "READ_ONLY",
      enable_external_access: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      threads: "4",
      lock_configuration: "true",
    });
    const old = this.instance;
    this.instance = inst;
    this.current = cur;
    this.filePath = file;
    this.cache.clear();
    this.tableSet = null;
    this.columnsByTable = null;
    if (old) setTimeout(() => old.closeSync(), 30_000).unref(); // let in-flight queries on the old colour finish
    return true;
  }

  private async ensure(): Promise<DuckDBInstance> {
    await this.refresh();
    if (!this.instance) throw new ApiError(503, "NOT_READY", "No published analytics yet - run the pipeline");
    return this.instance;
  }

  async connect(): Promise<DuckDBConnection> {
    return (await this.ensure()).connect();
  }

  /** Trusted, parameterised SQL written by the tools (never model SQL - that goes through `guardedQuery`). */
  async rows(sql: string, params: unknown[] = []): Promise<RowObject[]> {
    const con = await this.connect();
    try {
      const reader = await con.runAndReadAll(sql, params as never);
      return readerRows(reader).rows;
    } finally {
      con.closeSync();
    }
  }

  async one(sql: string, params: unknown[] = []): Promise<RowObject | null> {
    return (await this.rows(sql, params))[0] ?? null;
  }

  /** Executes with a watchdog: DuckDB has no statement timeout, so interrupt() after timeoutMs (SPEC §15.2). */
  async execute(sql: string, opts: { timeoutMs?: number; maxRows?: number } = {}) {
    const timeoutMs = opts.timeoutMs ?? config().queryTimeoutMs;
    const con = await this.connect();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      con.interrupt();
    }, timeoutMs);
    const t0 = performance.now();
    try {
      const reader = await con.runAndReadAll(sql);
      const { columns, rows } = readerRows(reader, opts.maxRows ?? 1000);
      return { columns, rows, totalRows: reader.currentRowCount, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (timedOut) throw new QueryTimeout(`query exceeded ${timeoutMs} ms and was interrupted`);
      throw e;
    } finally {
      clearTimeout(timer);
      con.closeSync();
    }
  }

  async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.refresh();
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const v = await fn();
    this.cache.set(key, v);
    return v;
  }

  async tables(): Promise<Set<string>> {
    await this.ensure();
    if (!this.tableSet) {
      const rows = await this.rows(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY 1",
      );
      this.tableSet = new Set(rows.map((r) => String(r.table_name)));
    }
    return this.tableSet;
  }

  async hasTable(name: string): Promise<boolean> {
    return (await this.tables()).has(name);
  }

  async columns(table: string): Promise<string[]> {
    await this.ensure();
    if (!this.columnsByTable) {
      const rows = await this.rows(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position",
      );
      const m = new Map<string, string[]>();
      for (const r of rows) {
        const t = String(r.table_name);
        if (!m.has(t)) m.set(t, []);
        m.get(t)!.push(String(r.column_name));
      }
      this.columnsByTable = m;
    }
    return this.columnsByTable.get(table) ?? [];
  }

  close(): void {
    this.instance?.closeSync();
    this.instance = null;
    this.current = null;
  }

  /** Modification time of current.json, for the health endpoint. */
  currentMtime(): string | null {
    try {
      return statSync(path.join(this.opts.analyticsDir ?? config().analyticsDir, "current.json")).mtime.toISOString();
    } catch {
      return null;
    }
  }
}

let serve: ServeDB | null = null;
export function SERVE(): ServeDB {
  if (!serve) serve = new ServeDB();
  return serve;
}
/** Tests point the singleton at a fixture file. */
export function setServe(db: ServeDB | null): void {
  serve?.close();
  serve = db;
}

export function parseJson<T = Json>(v: Json | undefined): T | Json | undefined {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v;
    }
  }
  return v;
}
