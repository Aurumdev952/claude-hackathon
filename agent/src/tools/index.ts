/** Tool registry: role -> tool definitions; adapters to AI SDK tools (with toModelOutput) and model-safe views. */
import { tool, type Tool, type ToolSet } from "ai";
import type { Role } from "../context.js";
import { pseudonymise, ministryView } from "../guardrails/suppress.js";
import { DOCTOR_TOOLS, MINISTRY_TOOLS, type ToolName } from "../widgets/specs.js";
import { getCareCascade } from "./cascade.js";
import { makeChart } from "./charts.js";
import { getFacilityQuality, getStageMix, getSurvival } from "./clinical.js";
import { describeTables } from "./describe_tables.js";
import { getDistrictRanking } from "./districts.js";
import { getKpis } from "./kpis.js";
import { getModelMetrics } from "./models.js";
import { getPatient, listAlerts, listHighRiskPatients } from "./patient.js";
import { makePatientWidget } from "./patient_widget.js";
import { queryMarts } from "./query_marts.js";
import { getRatesTrend } from "./rates.js";
import { getPatientRisk } from "./risk.js";
import { runPythonTool } from "./run_python.js";
import { getPatientTimeline } from "./timeline.js";
import type { ToolCtx, ToolDef } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any, any>;

export const ALL_TOOLS: AnyToolDef[] = [
  describeTables, queryMarts, getKpis, getRatesTrend, getDistrictRanking, getCareCascade, getStageMix, getSurvival,
  getFacilityQuality, getModelMetrics, getPatient, getPatientTimeline, getPatientRisk, listHighRiskPatients, listAlerts,
  makeChart, makePatientWidget, runPythonTool,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolDefsFor(role: Role): AnyToolDef[] {
  const names: readonly ToolName[] = role === "doctor" ? DOCTOR_TOOLS : MINISTRY_TOOLS;
  return names.map((n) => BY_NAME.get(n)!).filter((d) => d && d.roles.includes(role));
}

/** Rows beyond this are cut from the model's view (the UI and make_chart still get every row via dataset_id). */
const MODEL_ROWS = 200;

function trimRows(o: unknown, depth = 0): unknown {
  if (!o || typeof o !== "object" || depth > 3) return o;
  if (Array.isArray(o)) return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === "rows" && Array.isArray(v) && v.length > MODEL_ROWS) {
      out[k] = v.slice(0, MODEL_ROWS);
      out.rows_shown_to_model = MODEL_ROWS;
    } else out[k] = typeof v === "object" ? trimRows(v, depth + 1) : v;
  }
  return out;
}

/** What leaves the server for a model (ours or an MCP client): tool view + role privacy filter. Never contains names. */
export function modelSafe(def: AnyToolDef, output: unknown, t: ToolCtx): unknown {
  const view = def.modelView ? def.modelView(output, t) : output;
  const filtered = t.ctx.role === "doctor" ? pseudonymise(view) : ministryView(view);
  return trimRows(filtered);
}

export function aiTool(def: AnyToolDef, t: ToolCtx): Tool {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: async (input: unknown) => {
      try {
        return await def.execute(def.inputSchema.parse(input), t);
      } catch (e) {
        return { ok: false, error: `${def.name} failed: ${String((e as Error).message ?? e).slice(0, 300)}` };
      }
    },
    toModelOutput: ({ output }: { output: unknown }) => ({ type: "json", value: JSON.parse(JSON.stringify(modelSafe(def, output, t) ?? null)) }),
  } as never) as Tool;
}

/** AI SDK ToolSet for one request (the same definitions also feed the MCP server). */
export function buildTools(t: ToolCtx): ToolSet {
  const out: ToolSet = {};
  for (const def of toolDefsFor(t.ctx.role)) out[def.name] = aiTool(def, t);
  return out;
}
