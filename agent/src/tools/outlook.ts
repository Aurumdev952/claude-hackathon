/**
 * v3 ministry tools (plan §2d, §4, §5; contract docs/contracts/v3-loop.md §5, §7): care coordination funnel, incidence
 * forecasts with 80/95% fans, closed-form scenarios (FastAPI POST /forecast/scenario) and the learning loop.
 *
 * Aggregates only. Counts below 5 are suppressed (null + "<5" label) together with the rates derived from them, exactly as
 * api/routers/care.py and api/routers/forecast.py do. Everything is SYNTHETIC; scenario effects are associational.
 */
import { z } from "zod";
import { SERVE, parseJson, type RowObject } from "../db/duck.js";
import { api, upstreamMessage } from "../lib/upstream.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const FORECAST_CAVEAT =
  "Synthetic data. Forecasts are model projections from a synthetic national registry (APC Poisson + ETS ensemble, " +
  "bootstrap intervals); scenario effects are associational, not causal.";
const CARE_CAVEAT =
  "Synthetic data. Care-pathway and usual-route patients differ in who was flagged and when: comparisons are associational.";

type Obj = Record<string, unknown>;

/** Port of api/routers/care.py `suppress`: counts 1-4 -> null + `<col>_label: "<5"`; derived values go null with them. */
export function suppressCells<T extends Obj>(row: T, counts: readonly string[], derived: readonly string[] = []): T {
  const out: Obj = { ...row };
  let hit = false;
  for (const f of counts) {
    const v = out[f];
    if (typeof v === "number" && v > 0 && v < 5) {
      out[f] = null;
      out[`${f}_label`] = "<5";
      hit = true;
    }
  }
  if (hit) for (const f of derived) if (f in out) out[f] = null;
  return out as T;
}

const FUNNEL = ["flagged", "approved", "notified", "attended", "endoscopy", "cancer_found", "early_stage"] as const;
const FUNNEL_LABEL: Record<string, string> = {
  flagged: "Flagged", approved: "Plan approved", notified: "Patient notified", attended: "Attended", endoscopy: "Endoscopy done",
  cancer_found: "Cancer found", early_stage: "Early stage (I-II)",
};

export const getCareFunnel = defineTool({
  name: "get_care_funnel",
  title: "Care coordination funnel",
  description:
    "Care coordination programme (v3, aggregates only): funnel flagged -> plan approved -> patient notified -> attended -> " +
    "endoscopy done -> cancer found -> early stage, with pct_of_prev; by_district funnel; adherence (completion rate and " +
    "median days to completion) by channel, distance band, sex, age band, district or pathway; median days to endoscopy; " +
    "impact (stage at diagnosis and 1-year survival, care pathway vs usual route; associational) and CHW workload. Filter by " +
    "period (from / to, YYYY-MM) and district code. Cells below 5 are suppressed ('<5').",
  roles: ["ministry"],
  inputSchema: z.object({
    from: z.string().regex(/^\d{4}(-\d{2})?(-\d{2})?$/).optional(),
    to: z.string().regex(/^\d{4}(-\d{2})?(-\d{2})?$/).optional(),
    district: z.string().optional().describe("District code, e.g. NOR-MUS"),
    adherence_by: z.enum(["channel", "distance", "sex", "age", "district", "pathway"]).default("channel"),
  }),
  async execute(i, t) {
    const db = SERVE();
    if (!(await db.hasTable("mart_care_funnel"))) return { ok: false, error: "Care coordination marts are not published yet" };
    const where = ["TRUE"];
    const params: unknown[] = [];
    const day = (s: string, end: boolean) => (s.length === 4 ? `${s}-${end ? "12-31" : "01-01"}` : s.length === 7 ? `${s}-${end ? "28" : "01"}` : s);
    if (i.from) { where.push("period >= CAST(? AS DATE)"); params.push(day(i.from, false)); }
    if (i.to) { where.push("period <= CAST(? AS DATE)"); params.push(day(i.to, true)); }
    if (i.district) { where.push("district_code = ?"); params.push(i.district); }
    const w = where.join(" AND ");
    const sums = FUNNEL.map((f) => `sum(${f})::INT AS ${f}`).join(", ");
    const tot = (await db.one(`SELECT ${sums} FROM mart_care_funnel WHERE ${w}`, params)) ?? {};
    let prev: number | null = null;
    const steps = FUNNEL.map((f) => {
      const n = Number(tot[f] ?? 0);
      const row = suppressCells({ step: f, label: FUNNEL_LABEL[f], n, pct_of_prev: prev && prev >= 5 && n >= 5 ? round((100 * n) / prev, 1) : null }, ["n"], ["pct_of_prev"]);
      prev = n;
      return row;
    });
    const byDistrict = (await db.rows(
      `SELECT f.district_code, d.name AS district_name, ${FUNNEL.map((x) => `sum(f.${x})::INT AS ${x}`).join(", ")}
       FROM mart_care_funnel f LEFT JOIN ref_district d USING (district_code) WHERE ${w.replace(/\b(period|district_code)\b/g, "f.$1")} GROUP BY 1, 2 ORDER BY 3 DESC`,
      params,
    )).map((r) => suppressCells(r, FUNNEL));
    const adherence = (await db.hasTable("mart_care_adherence"))
      ? (await db.rows("SELECT dim, level, n, adhered, rate, median_days FROM mart_care_adherence WHERE dim = ? ORDER BY level", [i.adherence_by]))
          .map((r) => suppressCells({ ...r, rate_pct: typeof r.rate === "number" ? round(100 * r.rate, 1) : null, median_days: round(r.median_days, 1) }, ["n", "adhered"], ["rate", "rate_pct", "median_days"]))
      : [];
    const endo = (await db.hasTable("mart_care_adherence"))
      ? await db.one("SELECT n, adhered, rate, median_days FROM mart_care_adherence WHERE dim = 'pathway' AND level = 'ENDOSCOPY_REFERRAL'")
      : null;
    const daysToEndoscopy = endo ? suppressCells({ n: endo.n, median_days: round(endo.median_days, 1) }, ["n"], ["median_days"]) : null;
    const impact = (await db.hasTable("mart_care_impact"))
      ? (await db.rows("SELECT route, n, early_stage_pct, surv_1y, n_surv_eligible FROM mart_care_impact ORDER BY route"))
          .map((r) => suppressCells({ ...r, early_stage_pct: round(r.early_stage_pct, 1), surv_1y: round(r.surv_1y, 3) }, ["n", "n_surv_eligible"], ["early_stage_pct", "surv_1y"]))
      : [];
    const chw = (await db.hasTable("mart_chw_workload"))
      ? (await db.rows("SELECT w.district_code, d.name AS district_name, w.open_visits, w.overdue, w.completed_30d FROM mart_chw_workload w LEFT JOIN ref_district d USING (district_code) ORDER BY open_visits DESC"))
          .map((r) => suppressCells(r, ["open_visits", "overdue", "completed_30d"]))
      : [];
    return {
      ok: true, filters: { from: i.from ?? null, to: i.to ?? null, district: i.district ?? null },
      dataset_id: t.datasets.register("get_care_funnel", steps as RowObject[]), rows: steps,
      by_district: { dataset_id: t.datasets.register("get_care_funnel", byDistrict), rows: byDistrict },
      adherence: { by: i.adherence_by, dataset_id: t.datasets.register("get_care_funnel", adherence as RowObject[]), rows: adherence },
      days_to_endoscopy: daysToEndoscopy,
      impact: { rows: impact, caveat: CARE_CAVEAT },
      chw_workload: chw,
      caveats: [CARE_CAVEAT, "Cells with fewer than 5 patients are suppressed (shown as <5)."],
    };
  },
});

// ------------------------------------------------------------------------------------------------ forecast
const AGES = ["ALL", "<50", "50-64", "65+"] as const;

async function caseDef(): Promise<string> {
  const db = SERVE();
  if (await db.hasTable("ml_forecast_runs")) {
    const r = await db.one("SELECT case_def FROM ml_forecast_runs ORDER BY created_at DESC LIMIT 1");
    if (r?.case_def) return String(r.case_def);
  }
  return "REGISTRY";
}

export const getForecast = defineTool({
  name: "get_forecast",
  title: "Incidence forecast",
  description:
    "Yearly gastric cancer incidence history and forecast to 2031 (v3 Outlook; synthetic national registry 2000-2025): " +
    "mean with 80% and 95% prediction intervals, for geo NATIONAL / PROVINCE (code KGL NOR SOU EAS WES) / DISTRICT (code e.g. " +
    "NOR-MUS), sex ALL/M/F, age ALL/<50/50-64/65+, metric cases or asr (per 100,000). Rows: year, kind (history/forecast), " +
    "observed, forecast, lo80, hi80, lo95, hi95. Also the horizon summary (mean and 95% interval in the last year, change vs " +
    "the last observed year), the driver decomposition (population growth, ageing, risk change) and backtest accuracy " +
    "(MAPE, 80/95% coverage). Chart with make_chart type line, series observed + forecast (dashed) and fan {lo80, hi80, lo95, hi95}.",
  roles: ["ministry"],
  inputSchema: z.object({
    geo: z.enum(["NATIONAL", "PROVINCE", "DISTRICT"]).default("NATIONAL"),
    code: z.string().optional().describe("Province or district code (not needed for NATIONAL)"),
    sex: z.enum(["ALL", "M", "F"]).default("ALL"),
    age: z.enum(AGES).default("ALL"),
    metric: z.enum(["cases", "asr"]).default("cases"),
    year_from: z.number().int().min(2000).max(2030).default(2010),
  }),
  async execute(i, t) {
    const db = SERVE();
    if (!(await db.hasTable("mart_forecast"))) return { ok: false, error: "Forecasts are not published yet (make forecast)" };
    if (i.geo !== "NATIONAL" && !i.code) return { ok: false, error: "code is required for PROVINCE and DISTRICT" };
    const cd = await caseDef();
    const geoKey = i.geo === "NATIONAL" ? "NATIONAL" : String(i.code).toUpperCase();
    const sid = `${geoKey}|${i.sex}|${i.age}|${cd}`;
    const raw = await db.rows(
      `SELECT year(period)::INT AS year, kind, mean, lo80, hi80, lo95, hi95, model, run_id, cases_obs FROM mart_forecast
       WHERE series_id = ? AND metric = ? AND freq = 'Y' ORDER BY period`,
      [sid, i.metric],
    );
    if (!raw.length) {
      const avail = await db.rows("SELECT DISTINCT series_id FROM mart_forecast WHERE freq = 'Y' ORDER BY 1 LIMIT 60");
      return { ok: false, error: `No forecast for ${sid}`, available_series: avail.map((r) => r.series_id) };
    }
    const d = i.metric === "asr" ? 2 : 0;
    const rows: RowObject[] = raw.filter((r) => Number(r.year) >= i.year_from).map((r) => {
      const hist = r.kind === "history";
      const small = hist && typeof r.cases_obs === "number" && r.cases_obs < 5;
      return {
        year: r.year, kind: r.kind,
        observed: hist && !small ? round(r.mean, d) : null,
        forecast: hist ? null : round(r.mean, d),
        lo80: hist ? null : round(r.lo80, d), hi80: hist ? null : round(r.hi80, d),
        lo95: hist ? null : round(r.lo95, d), hi95: hist ? null : round(r.hi95, d),
        ...(small ? { observed_label: "<5" } : {}),
      };
    });
    // bridge: the last observed year also starts the dashed forecast line, so the two series connect
    const lastHist = [...rows].reverse().find((r) => r.kind === "history" && r.observed !== null);
    if (lastHist) lastHist.forecast = lastHist.observed;
    const fc = raw.filter((r) => r.kind === "forecast");
    const last = fc.at(-1);
    const base = [...raw].reverse().find((r) => r.kind === "history" && !(typeof r.cases_obs === "number" && r.cases_obs < 5));
    const summary = last ? {
      horizon_year: last.year, mean: round(last.mean, d), lo80: round(last.lo80, d), hi80: round(last.hi80, d), lo95: round(last.lo95, d), hi95: round(last.hi95, d),
      last_observed_year: base?.year ?? null, last_observed: base ? round(base.mean, d) : null,
      change_pct: base && typeof base.mean === "number" && typeof last.mean === "number" && base.mean > 0 ? round((100 * (last.mean - base.mean)) / base.mean, 1) : null,
      model: last.model, run_id: last.run_id,
    } : null;
    const drivers = (await db.hasTable("mart_forecast_drivers"))
      ? (await db.rows("SELECT component, from_year, to_year, cases, pct, cases_from, cases_to, total_change FROM mart_forecast_drivers WHERE geo_code = ? ORDER BY component",
          [i.geo === "NATIONAL" ? "RW" : geoKey]))
          .map((r) => ({ component: r.component, from_year: r.from_year, to_year: r.to_year, cases: round(r.cases, 0), pct_of_start: round(r.pct, 1), cases_from: round(r.cases_from, 0), cases_to: round(r.cases_to, 0), total_change: round(r.total_change, 0) }))
      : [];
    let backtest: Obj | null = null;
    if (await db.hasTable("ml_forecast_backtest")) {
      for (const s of [sid, `NATIONAL|ALL|ALL|${cd}`]) {
        const b = await db.one("SELECT avg(mape) AS mape, avg(cov80) AS cov80, avg(cov95) AS cov95, count(*)::INT AS n_points FROM ml_forecast_backtest WHERE series_id = ?", [s]);
        if (b && Number(b.n_points) > 0) {
          backtest = { series_id: s, mape_pct: round(b.mape, 1), cov80: round(b.cov80, 2), cov95: round(b.cov95, 2), n_points: b.n_points };
          break;
        }
      }
    }
    return {
      ok: true, series_id: sid, metric: i.metric, unit: i.metric === "cases" ? "cases per year" : "ASR per 100,000",
      summary, drivers, backtest,
      chart_hint: { type: "line", x: "year", series: [{ key: "observed" }, { key: "forecast", dashed: true }], fan: { lo80: "lo80", hi80: "hi80", lo95: "lo95", hi95: "hi95" } },
      caveats: [FORECAST_CAVEAT],
      dataset_id: t.datasets.register("get_forecast", rows), rows,
    };
  },
});

export const runForecastScenario = defineTool({
  name: "run_forecast_scenario",
  title: "Forecast scenario",
  description:
    "What-if scenario on the national forecast (POST /forecast/scenario, closed form): hp_coverage_delta = share of H. pylori " +
    "infected people newly treated (0-1, e.g. 0.5 = +50% test-and-treat coverage), smoking_delta and salt_delta = relative " +
    "change in prevalence (-0.2 = -20%), endoscopy_access = district codes that gain an endoscopy service (changes the " +
    "stage mix only), until = last year (<= 2031). Returns baseline vs scenario cases per year with 95% intervals, " +
    "cases_averted (and range), the stage shift (early-stage %) and the assumptions. Effects are associational and synthetic.",
  roles: ["ministry"],
  inputSchema: z.object({
    hp_coverage_delta: z.number().min(0).max(1).default(0),
    smoking_delta: z.number().min(-1).max(1).default(0),
    salt_delta: z.number().min(-1).max(1).default(0),
    endoscopy_access: z.array(z.string()).max(30).default([]),
    until: z.number().int().min(2026).max(2035).default(2031),
  }),
  async execute(i, t) {
    try {
      const { data, envelope } = await api<{
        baseline: { year: number; mean: number; lo95: number; hi95: number }[];
        scenario: { year: number; mean: number; lo95: number; hi95: number }[];
        cases_averted: number; cases_averted_range?: unknown; stage_shift?: Obj; assumptions?: unknown[]; elapsed_ms?: number;
      }>(t.ctx, "/forecast/scenario", { method: "POST", body: i });
      const sc = new Map((data.scenario ?? []).map((r) => [r.year, r]));
      const rows = (data.baseline ?? []).map((b) => {
        const s = sc.get(b.year);
        return {
          year: b.year, baseline: round(b.mean, 0), scenario: s ? round(s.mean, 0) : null,
          averted: s ? round(b.mean - s.mean, 0) : null,
          baseline_lo95: round(b.lo95, 0), baseline_hi95: round(b.hi95, 0), scenario_lo95: s ? round(s.lo95, 0) : null, scenario_hi95: s ? round(s.hi95, 0) : null,
        };
      });
      const rng = data.cases_averted_range;
      const ss = data.stage_shift ?? {};
      return {
        ok: true, inputs: i,
        cases_averted: round(data.cases_averted, 0),
        cases_averted_range: Array.isArray(rng) ? rng.map((x) => round(x, 0)) : rng && typeof rng === "object" ? Object.fromEntries(Object.entries(rng as Obj).map(([k, v]) => [k, round(v, 0)])) : null,
        stage_shift: {
          early_pct_baseline: round(ss.early_pct_baseline, 1), early_pct_scenario: round(ss.early_pct_scenario, 1),
          districts_gaining_access: ss.districts_gaining_access ?? [],
        },
        assumptions: (data.assumptions ?? []).slice(0, 8),
        elapsed_ms: data.elapsed_ms ?? null,
        caveats: [FORECAST_CAVEAT, typeof envelope.note === "string" ? envelope.note : null].filter(Boolean),
        dataset_id: t.datasets.register("run_forecast_scenario", rows as RowObject[]), rows,
      };
    } catch (e) {
      return upstreamMessage(e);
    }
  },
});

// ------------------------------------------------------------------------------------------------ learning loop
export const getModelMonitoring = defineTool({
  name: "get_model_monitoring",
  title: "Learning loop and model monitoring",
  description:
    "Learning loop status (v3): the active champion and the latest challenger risk model (Tier 2, retrained every 30 sim " +
    "days on verified care outcomes with inverse-propensity weights), the promotion gates (AUROC, AUPRC, PPV at HIGH and " +
    "Brier no worse than champion - 0.01, calibration slope, subgroup AUROC drop <= 0.05, HIGH alert volume within +/-25% or " +
    "a small absolute change) with pass / fail, retrain history, feedback-label counts and monitoring (feature drift PSI, " +
    "alert volume, PPV on verified outcomes). A person promotes a challenger in Model Arena; the agent cannot.",
  roles: ["ministry"],
  inputSchema: z.object({ top_drift: z.number().int().min(1).max(20).default(8) }),
  async execute(i, t) {
    const db = SERVE();
    const reg = (await db.hasTable("ml_model_registry")) ? await db.rows("SELECT * FROM ml_model_registry ORDER BY trained_at DESC NULLS LAST") : [];
    const card = (r: RowObject | undefined) => r ? {
      model_id: r.model_id, tier: r.tier, status: r.status ?? (r.is_active ? "champion" : null), is_active: r.is_active,
      trained_at: r.trained_at ?? null, train_window: r.train_window ?? null, parent_model_id: r.parent_model_id ?? null,
      n_feedback_labels: r.n_feedback_labels ?? null, promoted_at: r.promoted_at ?? null, promote_reason: r.promote_reason ?? null,
    } : null;
    const tier2 = reg.filter((r) => Number(r.tier) === 2);
    const champion = card(tier2.find((r) => r.is_active) ?? reg.find((r) => r.is_active));
    const challenger = card(tier2.find((r) => r.status === "challenger"));
    let latest: Obj | null = null;
    let history: Obj[] = [];
    if (await db.hasTable("ml_retrain_runs")) {
      const runs = await db.rows("SELECT run_id, sim_time, champion_id, challenger_id, decision, n_feedback_labels, gates, metrics, train_window, runtime_s FROM ml_retrain_runs ORDER BY sim_time DESC, started_at DESC LIMIT 10")
        .catch(() => db.rows("SELECT run_id, sim_time, champion_id, challenger_id, decision, gates FROM ml_retrain_runs ORDER BY sim_time DESC LIMIT 10"));
      history = runs.map((r) => ({ run_id: r.run_id, sim_time: r.sim_time, champion_id: r.champion_id, challenger_id: r.challenger_id, decision: r.decision, n_feedback_labels: r.n_feedback_labels ?? null }));
      if (runs[0]) {
        const g = parseJson(runs[0].gates);
        latest = {
          run_id: runs[0].run_id, decision: runs[0].decision,
          gates: Array.isArray(g) ? (g as Obj[]).map((x) => ({ name: x.name, value: round(x.value, 4), threshold: x.threshold, pass: x.pass, champion: round(x.champion, 4), challenger: round(x.challenger, 4), note: x.note ?? null })) : [],
        };
      }
    }
    let monitoring: Obj = {};
    let driftRows: RowObject[] = [];
    if (await db.hasTable("mart_model_monitoring")) {
      const mon = await db.rows(`SELECT metric, value, n, detail, as_of, model_id FROM mart_model_monitoring
                                 WHERE as_of = (SELECT max(as_of) FROM mart_model_monitoring m2 WHERE m2.metric = mart_model_monitoring.metric)`);
      driftRows = mon.filter((m) => String(m.metric).startsWith("psi:"))
        .map((m) => ({ feature: String(m.metric).slice(4), psi: round(m.value, 3), level: m.detail ?? null }))
        .sort((a, b) => Number(b.psi ?? 0) - Number(a.psi ?? 0)).slice(0, i.top_drift);
      for (const m of mon.filter((x) => !String(x.metric).startsWith("psi:"))) {
        monitoring[String(m.metric)] = suppressCells({ value: round(m.value, 3), n: m.n, detail: m.detail ?? null, as_of: m.as_of }, ["n"], ["value"]);
      }
      monitoring = { ...monitoring, drift_levels: { major: driftRows.filter((d) => d.level === "major").length } };
    }
    let feedback: Obj | null = null;
    if (await db.hasTable("ml_feedback_labels")) {
      const fb = await db.rows("SELECT source, label_kind, count(*)::INT AS n, sum(label)::INT AS positives FROM ml_feedback_labels GROUP BY 1, 2 ORDER BY 1, 2")
        .catch(() => db.rows("SELECT source, NULL AS label_kind, count(*)::INT AS n, sum(label)::INT AS positives FROM ml_feedback_labels GROUP BY 1 ORDER BY 1"));
      const total = fb.reduce((a, r) => a + Number(r.n ?? 0), 0);
      feedback = { ...suppressCells({ n: total }, ["n"]), by_source: fb.map((r) => suppressCells(r, ["n", "positives"])) };
    }
    return {
      ok: true, champion, challenger, latest_run: latest, history, feedback, monitoring,
      governance: "Challengers are trained automatically and registered inactive. A person reviews the comparison and clicks " +
        "Promote in Model Arena (with a reason); promotion re-scores and is audited, and Roll back restores the previous champion.",
      caveats: ["Synthetic data. Verified outcomes come from simulated care follow-up."],
      dataset_id: t.datasets.register("get_model_monitoring", driftRows), rows: driftRows,
    };
  },
});
