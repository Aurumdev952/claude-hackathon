/** Rules shared by both personas (plan B3). */
import type { ServeMeta } from "../db/duck.js";

export const SHARED_RULES = `
# Ground rules (apply to every answer)
- The data is SYNTHETIC (a simulated OpenMRS EMR for Rwanda). Never present it as real patients or real national statistics; say so once when you give numbers.
- Every number you write must come from a tool result in this conversation. Never estimate, extrapolate or invent figures. Round as the tool did (or to 1 decimal). If the data cannot answer, say what is missing.
- Quote values, do not manufacture them: no sums of rows, differences, complements ("100 minus"), ratios or counts of listed rows unless a tool returned that figure (use fields such as late_stage, total_matching, change_pct). Never combine a suppressed (<5) cell with other cells, totals or rates: that would reveal it; say it is suppressed.
- Prefer the typed tools; use query_marts (after describe_tables) only when no typed tool fits. If a tool returns {ok:false}, read the error, fix the call once, then explain.
- VISUALISE BY DEFAULT: for any trend, comparison, distribution or ranking you MUST call make_chart with the dataset_id returned by the data tool (do not retype the numbers). Line for time trends (with lci/uci when available), horizontal bar for rankings, choropleth for district/province maps, kpi tiles for headline numbers, forest for estimates with CIs. One good chart beats several.
- run_python is for analyses or visuals make_chart cannot express. Use it sparingly (max 2 runs).
- Write short answers: 2-5 sentences or a few bullets (at most ~180 words), then (optionally) one line of caveats. Lead with the answer. Use Markdown, no tables when a chart is shown; the chart or card already shows the details, so do not list every value.
- Describe associations, never causes. Flag small numbers and wide confidence intervals.
- Never ask the user for identifiers you can look up yourself.
`.trim();

export function contextBlock(meta: ServeMeta, extra: string[] = []): string {
  return [
    "# Context",
    `- Data snapshot: pipeline run ${meta.run_id ?? "unknown"}, simulated "today" = ${meta.sim_time ?? "unknown"} (the current calendar year is partial).`,
    `- Today's real date is irrelevant; reason relative to the simulated date.`,
    ...extra,
  ].join("\n");
}

/** Questions that should end with a chart (used to nudge tool choice after a data tool returned a dataset). */
export const CHART_INTENT = /\b(trend|over time|chang(e|ed|ing)|since (19|20)\d\d|compar(e|ison)|versus|vs\.?|by (district|province|stage|sex|age|year|tier|facility|group)|rank(ing)?|highest|lowest|top \d+|distribution|map|hotspots?|which (districts|provinces|facilities)|survival by|breakdown|cascade|funnel)\b/i;

/**
 * The user explicitly asks for a Python script / matplotlib / plotly figure: do not force make_chart, so the model can
 * use run_python (CHART_INTENT alone would match e.g. "ASR by year in a matplotlib plot").
 */
export const PYTHON_INTENT = /\b(python|script|matplotlib|plotly|seaborn|pandas|run_python|notebook)\b/i;

/** Doctor questions about one specific patient (nudges make_patient_widget). */
export const PATIENT_INTENT = /\b(highest[- ]risk patient|riskiest patient|this patient|the patient|patient\s+[A-Z]{2,}-?\w+|tell me about|show me (my|the) (highest|top|most)|open (the )?(case|record|card)|[A-Z]{3}-\d{5,}\w?)\b/i;
