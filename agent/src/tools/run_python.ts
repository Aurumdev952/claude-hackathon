/** run_python: model-written Python over guarded data in the sandbox (PNG / interactive HTML artifacts). */
import { z } from "zod";
import { guardedQuery } from "../db/query.js";
import { runPython } from "../sandbox/runner.js";
import type { ArtifactSpec } from "../widgets/specs.js";
import { defineTool } from "./types.js";

export const MAX_PYTHON_RUNS_PER_TURN = 2;
const SANDBOX_ROWS = 1000;

export const runPythonTool = defineTool({
  name: "run_python",
  title: "Python sandbox",
  description:
    "Runs a short Python 3.11 script in an isolated sandbox (no network, no file system, 30 s) to build custom visualisations " +
    "or statistics that make_chart cannot express (e.g. small multiples, regression fits, heatmaps). The data is loaded as a " +
    "pandas DataFrame `df` from `dataset_id` (rows of an earlier tool) or from `sql` (same guardrails as query_marts, max 1000 " +
    "rows). Available: pd, np, plt (matplotlib, Agg), px / go (plotly), scipy. Open matplotlib figures are saved as PNG and " +
    "plotly figures assigned to variables as HTML automatically. print() output is returned. Use make_chart for standard " +
    "charts; at most 2 runs per answer.",
  roles: ["ministry", "doctor"],
  inputSchema: z.object({
    code: z.string().min(1).max(20_000).describe("Python source; use df, pd, np, plt, px, go"),
    dataset_id: z.string().optional(),
    sql: z.string().max(6000).optional(),
    title: z.string().max(160).optional(),
  }),
  async execute(i, t) {
    if (t.pythonRuns >= MAX_PYTHON_RUNS_PER_TURN) {
      return { ok: false, error: `run_python is limited to ${MAX_PYTHON_RUNS_PER_TURN} runs per answer; answer with what you have.` };
    }
    t.pythonRuns++;
    let rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    if (i.dataset_id) {
      const ds = t.datasets.get(i.dataset_id);
      if (!ds) return { ok: false, error: `Unknown dataset_id ${i.dataset_id}`, datasets: t.datasets.ids() };
      rows = ds.rows;
      columns = ds.columns;
    } else if (i.sql) {
      const r = await guardedQuery(t.ctx, i.sql, { maxRows: SANDBOX_ROWS });
      if (!r.ok) return { ok: false, error: r.error };
      rows = r.rows;
      columns = r.columns;
    }
    return runPython({ code: i.code, rows, columns, title: i.title });
  },
  modelView(o) {
    if (!("kind" in o)) return o;
    const a = o as ArtifactSpec;
    return {
      ok: a.ok, files: a.files.map((f) => f.name), stdout: a.stdout.slice(0, 2000), error: a.error,
      stderr_tail: a.ok ? undefined : a.stderr.slice(-1200), timed_out: a.timed_out,
      note: a.ok ? "Artifacts are displayed to the user." : "Fix the script once, or answer without it.",
    };
  },
});
