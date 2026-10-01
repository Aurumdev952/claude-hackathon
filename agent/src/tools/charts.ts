/**
 * make_chart: validates and echoes a ChartSpec (the chart widget). Data comes by reference (`dataset_id` from a data tool,
 * so numbers are never re-typed by the model) or inline (`data`, e.g. from MCP clients). The model only gets a short
 * confirmation back; the full spec goes to the UI as the tool output.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RowObject } from "../db/duck.js";
import { suppressSmallCells } from "../guardrails/suppress.js";
import { CHART_TYPES, ChartSpec, ChartWidget, type Cell, type KpiTile } from "../widgets/specs.js";
import { defineTool, type ToolCtx } from "./types.js";

const CellIn = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Fmt = z.enum(["number", "integer", "percent", "fraction_percent", "rate", "days", "text"]);

export const ChartInput = z.object({
  type: z.enum(CHART_TYPES).describe("line/area = trends over time; bar = comparisons and rankings; kpi = headline numbers; table; choropleth = district/province map; forest = estimates with CIs"),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  caption: z.string().max(400).optional().describe("One-sentence takeaway using numbers from the data"),
  unit: z.string().max(40).optional(),
  dataset_id: z.string().optional().describe("dataset_id returned by a data tool (preferred: exact rows, no copying)"),
  data: z.array(z.record(z.string(), CellIn)).max(500).optional().describe("Inline rows when there is no dataset_id"),
  filter: z
    .array(z.object({
      key: z.string(),
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_null"]),
      value: z.union([CellIn, z.array(CellIn)]).optional(),
    }))
    .max(6).optional().describe("Row filters applied to the dataset, e.g. [{key:'year', op:'gte', value:2015}]"),
  sort: z.object({ key: z.string(), desc: z.boolean().optional() }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  x: z.string().optional().describe("x column (line/area/bar), e.g. 'year' or 'name'"),
  x_label: z.string().optional(),
  y: z.string().optional().describe("Shorthand for a single series column"),
  series: z.array(z.object({
    key: z.string(), label: z.string().optional(), lci: z.string().optional(), uci: z.string().optional(), dashed: z.boolean().optional(),
  })).max(8).optional().describe("y columns (line/area/bar); lci/uci columns draw 95% CI bands"),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
  stacked: z.boolean().optional(),
  annotations: z.array(z.object({ x: z.union([z.string(), z.number()]), label: z.string().max(80) })).max(10).optional(),
  reference_lines: z.array(z.object({ y: z.number(), label: z.string().max(80).optional() })).max(4).optional(),
  tiles: z.array(z.object({
    label: z.string(), key: z.string().optional().describe("column read from the last row of the (filtered/sorted) data"),
    value: z.number().nullable().optional(), unit: z.string().optional(), format: Fmt.optional(),
    lci_key: z.string().optional(), uci_key: z.string().optional(), delta_key: z.string().optional(),
    trend: z.boolean().optional().describe("add a sparkline from this column across all rows"),
  })).max(8).optional().describe("kpi tiles"),
  columns: z.array(z.object({ key: z.string(), label: z.string().optional(), format: Fmt.optional() })).max(20).optional().describe("table columns (default: all)"),
  level: z.enum(["district", "province"]).optional().describe("choropleth level"),
  geo_key: z.string().optional(),
  value_key: z.string().optional(),
  label_key: z.string().optional().describe("choropleth / forest label column"),
  categorical: z.boolean().optional(),
  estimate_key: z.string().optional(),
  lci_key: z.string().optional(),
  uci_key: z.string().optional(),
  reference: z.number().optional(),
  log_scale: z.boolean().optional(),
});
export type ChartInput = z.infer<typeof ChartInput>;

type ChartResult = ChartWidget | { ok: false; error: string; available_columns?: string[]; datasets?: string[] };

function cmp(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function applyFilter(rows: RowObject[], f: NonNullable<ChartInput["filter"]>[number]): RowObject[] {
  return rows.filter((r) => {
    const v = r[f.key] as Cell;
    const w = f.value as Cell | Cell[] | undefined;
    switch (f.op) {
      case "eq": return v === w || String(v) === String(w);
      case "neq": return !(v === w || String(v) === String(w));
      case "gt": return v !== null && cmp(v, w as Cell) > 0;
      case "gte": return v !== null && cmp(v, w as Cell) >= 0;
      case "lt": return v !== null && cmp(v, w as Cell) < 0;
      case "lte": return v !== null && cmp(v, w as Cell) <= 0;
      case "in": return Array.isArray(w) && w.some((x) => x === v || String(x) === String(v));
      case "not_null": return v !== null && v !== undefined;
    }
  });
}

/** Flatten nested values (lists / structs) to strings so rows satisfy the Row schema. */
function flatRows(rows: RowObject[]): Record<string, Cell>[] {
  return rows.map((r) => {
    const o: Record<string, Cell> = {};
    for (const [k, v] of Object.entries(r)) o[k] = v === null || typeof v !== "object" ? (v as Cell) : JSON.stringify(v);
    return o;
  });
}

export function buildChart(i: ChartInput, t: ToolCtx): ChartResult {
  let rows: RowObject[];
  let sourceTool: string | undefined;
  let sql: string | undefined;
  if (i.dataset_id) {
    const ds = t.datasets.get(i.dataset_id);
    if (!ds) return { ok: false, error: `Unknown dataset_id ${i.dataset_id}. Use a dataset_id from this conversation or pass data inline.`, datasets: t.datasets.ids() };
    rows = ds.rows;
    sourceTool = ds.tool;
    sql = ds.sql ?? undefined;
  } else if (i.data?.length) {
    rows = t.ctx.role === "ministry" ? suppressSmallCells(i.data as RowObject[]) : (i.data as RowObject[]);
    sourceTool = "inline";
  } else {
    return { ok: false, error: "Pass dataset_id (from a data tool) or inline data." };
  }
  for (const f of i.filter ?? []) rows = applyFilter(rows, f);
  if (i.sort) rows = [...rows].sort((a, b) => (i.sort!.desc ? -1 : 1) * cmp(a[i.sort!.key] as Cell, b[i.sort!.key] as Cell));
  if (i.limit) rows = rows.slice(0, i.limit);
  if (!rows.length && i.type !== "table") return { ok: false, error: "No rows left after filtering." };
  const data = flatRows(rows.slice(0, 500));
  const cols = new Set(data.flatMap((r) => Object.keys(r)));
  const need = (k: string | undefined, what: string): string | null => {
    if (!k) return `${what} is required for a ${i.type} chart`;
    if (!cols.has(k)) return `column '${k}' (${what}) is not in the data`;
    return null;
  };
  const errs: string[] = [];
  const base = {
    title: i.title, subtitle: i.subtitle, caption: i.caption, unit: i.unit,
    source: { tool: sourceTool, ...(sql ? { sql } : {}), ...(i.dataset_id ? { note: `dataset ${i.dataset_id}` } : {}) },
  };
  let spec: unknown;
  if (i.type === "line" || i.type === "area" || i.type === "bar") {
    const series = i.series?.length ? i.series : i.y ? [{ key: i.y }] : [];
    const x = i.x ?? (cols.has("year") ? "year" : cols.has("period") ? "period" : cols.has("name") ? "name" : undefined);
    const e = need(x, "x");
    if (e) errs.push(e);
    if (!series.length) errs.push("series (or y) is required");
    for (const s of series) for (const k of [s.key, s.lci, s.uci]) if (k && !cols.has(k)) errs.push(`column '${k}' (series) is not in the data`);
    spec = {
      type: i.type, ...base, x: { key: x ?? "", label: i.x_label, kind: x === "year" || x === "period" ? "category" : undefined },
      series, data,
      ...(i.type === "bar" ? { orientation: i.orientation, stacked: i.stacked } : { annotations: i.annotations, ...(i.type === "area" ? { stacked: i.stacked } : {}) }),
      referenceLines: i.reference_lines,
    };
  } else if (i.type === "kpi") {
    const last = data[data.length - 1] ?? {};
    const tiles: KpiTile[] = (i.tiles ?? []).map((tl) => {
      if (tl.key && !cols.has(tl.key)) errs.push(`column '${tl.key}' (tile) is not in the data`);
      const raw = tl.key ? last[tl.key] : tl.value;
      const value = typeof raw === "number" ? raw : null;
      const label = tl.key && (last[`${tl.key}_label`] ?? (tl.key === "cases" ? last.cases_label : undefined));
      const lci = tl.lci_key ? last[tl.lci_key] : undefined;
      const uci = tl.uci_key ? last[tl.uci_key] : undefined;
      return {
        label: tl.label, value, unit: tl.unit ?? i.unit, format: tl.format,
        ...(typeof label === "string" ? { valueLabel: label } : {}),
        ...(tl.lci_key || tl.uci_key ? { ci: [typeof lci === "number" ? lci : null, typeof uci === "number" ? uci : null] as [number | null, number | null] } : {}),
        ...(tl.delta_key ? { delta: typeof last[tl.delta_key] === "number" ? (last[tl.delta_key] as number) : null } : {}),
        ...(tl.trend && tl.key ? { trend: data.slice(-60).map((r) => (typeof r[tl.key!] === "number" ? (r[tl.key!] as number) : null)) } : {}),
      };
    });
    if (!tiles.length) errs.push("tiles are required for a kpi chart");
    spec = { type: "kpi", ...base, tiles };
  } else if (i.type === "table") {
    const columns = i.columns?.length ? i.columns : [...cols].slice(0, 20).map((key) => ({ key }));
    for (const c of columns) if (data.length && !cols.has(c.key)) errs.push(`column '${c.key}' (table) is not in the data`);
    spec = { type: "table", ...base, columns, data };
  } else if (i.type === "choropleth") {
    const geo = i.geo_key ?? (cols.has("geo_code") ? "geo_code" : cols.has("district_code") ? "district_code" : undefined);
    for (const e of [need(geo, "geo_key"), need(i.value_key, "value_key")]) if (e) errs.push(e);
    const sample = String(data[0]?.[geo ?? ""] ?? "");
    const level = i.level ?? (sample.includes("-") ? "district" : "province");
    spec = {
      type: "choropleth", ...base, level, geoKey: geo ?? "", valueKey: i.value_key ?? "", labelKey: i.label_key ?? (cols.has("name") ? "name" : undefined),
      categorical: i.categorical ?? (i.value_key === "lisa_quadrant"), data: data.slice(0, 60),
    };
  } else {
    for (const [k, w] of [[i.label_key, "label_key"], [i.estimate_key, "estimate_key"], [i.lci_key, "lci_key"], [i.uci_key, "uci_key"]] as const) {
      const e = need(k, w);
      if (e) errs.push(e);
    }
    spec = {
      type: "forest", ...base, labelKey: i.label_key ?? "", estimateKey: i.estimate_key ?? "", lciKey: i.lci_key ?? "", uciKey: i.uci_key ?? "",
      reference: i.reference, logScale: i.log_scale, data: data.slice(0, 60),
    };
  }
  if (errs.length) return { ok: false, error: errs.join("; "), available_columns: [...cols] };
  const parsed = ChartSpec.safeParse(JSON.parse(JSON.stringify(spec)));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.slice(0, 4).map((x) => `${x.path.join(".")}: ${x.message}`).join("; "), available_columns: [...cols] };
  }
  return { kind: "chart", id: `ch_${randomUUID().slice(0, 8)}`, spec: parsed.data };
}

export const makeChart = defineTool({
  name: "make_chart",
  title: "Chart widget",
  description:
    "Renders a chart for the user. REQUIRED for trend, comparison, distribution and ranking answers. Reference the rows of a " +
    "previous data tool with dataset_id (preferred) and name the columns: line/area {x:'year', series:[{key:'asr', lci:'asr_lci', " +
    "uci:'asr_uci'}]}, bar {x:'name', y:'asr', orientation:'horizontal'} for rankings, kpi {tiles:[{label, key}]}, choropleth " +
    "{geo_key:'geo_code', value_key:'asr', level:'district'}, forest {label_key, estimate_key, lci_key, uci_key, reference}, table. " +
    "Optional filter/sort/limit select rows. Returns {ok, chart_id} or an error listing available columns.",
  roles: ["ministry", "doctor"],
  inputSchema: ChartInput,
  async execute(i, t) {
    return buildChart(i, t);
  },
  modelView(o) {
    if ("kind" in o) {
      const s = o.spec;
      const n = "data" in s ? s.data.length : s.tiles.length;
      return { ok: true, chart_id: o.id, type: s.type, title: s.title, points: n, note: "Chart is displayed to the user; do not repeat all of its values." };
    }
    return o;
  },
});
