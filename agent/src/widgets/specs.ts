/**
 * Widget contract shared by the agent backend and the chat UI (frontend alias `@agent/widgets`).
 *
 * This file must import ONLY `zod`: the frontend bundles it, so no Node APIs, no relative imports.
 *
 * Tool UI parts arrive as `part.type === "tool-<name>"`. The widget-producing tools and the shape of
 * `part.output` for each are:
 *   - tool-make_chart          -> ChartSpec          (render with ECharts)
 *   - tool-make_patient_widget -> PatientWidget      (doctor only)
 *   - tool-run_python          -> ArtifactSpec       (PNG <img> / plotly HTML in a sandboxed <iframe>)
 *   - tool-create_video        -> VideoWidget        (poster + status polling + download; v3)
 * Every other tool returns plain data (rows, KPIs) that the UI may show in an inspector.
 */
import { z } from "zod";

// --------------------------------------------------------------------------------------------- primitives
export const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof Cell>;
export const Row = z.record(z.string(), Cell);
export type Row = z.infer<typeof Row>;

export const ValueFormat = z.enum(["number", "integer", "percent", "fraction_percent", "rate", "days", "text"]);
export type ValueFormat = z.infer<typeof ValueFormat>;

/** Where the numbers came from (shown in the inspector; lets reviewers re-run the query). */
export const Source = z.object({
  tool: z.string().optional().describe("Tool that produced the data, e.g. get_rates_trend or query_marts"),
  sql: z.string().optional().describe("SQL actually executed (query_marts)"),
  note: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

const ChartBase = {
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  caption: z.string().max(400).optional().describe("One-sentence takeaway shown under the chart"),
  unit: z.string().max(40).optional().describe("Unit of the y values, e.g. 'per 100,000' or '%'"),
  caveats: z.array(z.string().max(300)).max(6).optional(),
  source: Source.optional(),
};

export const SeriesSpec = z.object({
  key: z.string().describe("Column in data holding the y value"),
  label: z.string().optional().describe("Legend label; defaults to key"),
  lci: z.string().optional().describe("Column holding the lower 95% CI (draws a band / error bar)"),
  uci: z.string().optional().describe("Column holding the upper 95% CI"),
  dashed: z.boolean().optional(),
  axis: z.enum(["left", "right"]).optional(),
});
export type SeriesSpec = z.infer<typeof SeriesSpec>;

export const AxisSpec = z.object({
  key: z.string().describe("Column in data used for the x axis (year, period, name, ...)"),
  label: z.string().optional(),
  kind: z.enum(["category", "time", "value"]).optional(),
});
export type AxisSpec = z.infer<typeof AxisSpec>;

export const Annotation = z.object({
  x: z.union([z.string(), z.number()]),
  label: z.string().max(80),
});
export const ReferenceLine = z.object({ y: z.number(), label: z.string().max(80).optional() });

/**
 * Forecast fan (v3): nested prediction bands drawn behind the line series, 95% lighter and 80% darker. Rows before the
 * forecast start carry null band values, so the band only covers the projection years.
 */
export const FanBand = z.object({
  lo95: z.string().describe("Column holding the lower 95% prediction bound"),
  hi95: z.string().describe("Column holding the upper 95% prediction bound"),
  lo80: z.string().optional().describe("Column holding the lower 80% prediction bound"),
  hi80: z.string().optional().describe("Column holding the upper 80% prediction bound"),
  start: z.union([z.string(), z.number()]).optional().describe("x value where the forecast starts (vertical marker)"),
  label: z.string().max(80).optional().describe("Band legend text, default 'Forecast interval (80% / 95%)'"),
});
export type FanBand = z.infer<typeof FanBand>;

// --------------------------------------------------------------------------------------------- chart specs
export const LineChartSpec = z.object({
  type: z.literal("line"),
  ...ChartBase,
  x: AxisSpec,
  series: z.array(SeriesSpec).min(1).max(8),
  data: z.array(Row).min(1).max(500),
  annotations: z.array(Annotation).max(10).optional().describe("Vertical markers, e.g. joinpoints or policy events"),
  referenceLines: z.array(ReferenceLine).max(4).optional(),
  yLabel: z.string().optional(),
  fan: FanBand.optional().describe("Forecast fan: 80% / 95% prediction bands (get_forecast rows)"),
});
export const AreaChartSpec = LineChartSpec.extend({ type: z.literal("area"), stacked: z.boolean().optional() });
export const BarChartSpec = z.object({
  type: z.literal("bar"),
  ...ChartBase,
  x: AxisSpec,
  series: z.array(SeriesSpec).min(1).max(8),
  data: z.array(Row).min(1).max(500),
  orientation: z.enum(["vertical", "horizontal"]).optional().describe("horizontal suits rankings of named items"),
  stacked: z.boolean().optional(),
  referenceLines: z.array(ReferenceLine).max(4).optional(),
  yLabel: z.string().optional(),
});

export const KpiTile = z.object({
  label: z.string().max(80),
  value: z.number().nullable(),
  valueLabel: z.string().max(40).optional().describe("Shown instead of value when value is null, e.g. '<5'"),
  unit: z.string().max(40).optional(),
  format: ValueFormat.optional(),
  ci: z.tuple([z.number().nullable(), z.number().nullable()]).optional(),
  delta: z.number().nullable().optional(),
  deltaLabel: z.string().max(60).optional(),
  trend: z.array(z.number().nullable()).max(60).optional().describe("Sparkline values, oldest first"),
});
export type KpiTile = z.infer<typeof KpiTile>;
export const KpiSpec = z.object({
  type: z.literal("kpi"),
  ...ChartBase,
  tiles: z.array(KpiTile).min(1).max(8),
});

export const TableColumn = z.object({
  key: z.string(),
  label: z.string().optional(),
  format: ValueFormat.optional(),
});
export const TableSpec = z.object({
  type: z.literal("table"),
  ...ChartBase,
  columns: z.array(TableColumn).min(1).max(20),
  data: z.array(Row).max(500),
});

export const ChoroplethSpec = z.object({
  type: z.literal("choropleth"),
  ...ChartBase,
  level: z.enum(["district", "province"]),
  geoKey: z.string().describe("Column with district codes (e.g. NOR-MUS) or province codes (KGL, NOR, SOU, EAS, WES)"),
  valueKey: z.string().describe("Column with the value to colour by"),
  labelKey: z.string().optional().describe("Column with the display name"),
  categorical: z.boolean().optional().describe("true for categories such as lisa_quadrant (HH, LL, HL, LH, NS)"),
  data: z.array(Row).min(1).max(60),
});

export const ForestSpec = z.object({
  type: z.literal("forest"),
  ...ChartBase,
  labelKey: z.string(),
  estimateKey: z.string(),
  lciKey: z.string(),
  uciKey: z.string(),
  reference: z.number().optional().describe("Null-effect line: 1 for ratios, 0 for differences / APC"),
  logScale: z.boolean().optional(),
  data: z.array(Row).min(1).max(60),
});

export const ChartSpec = z.discriminatedUnion("type", [
  LineChartSpec,
  AreaChartSpec,
  BarChartSpec,
  KpiSpec,
  TableSpec,
  ChoroplethSpec,
  ForestSpec,
]);
export type ChartSpec = z.infer<typeof ChartSpec>;
export type ChartType = ChartSpec["type"];
export const CHART_TYPES = ["line", "area", "bar", "kpi", "table", "choropleth", "forest"] as const;

/** Output of the make_chart tool: the validated spec plus an id the UI can key on. */
export const ChartWidget = z.object({
  kind: z.literal("chart"),
  id: z.string(),
  spec: ChartSpec,
});
export type ChartWidget = z.infer<typeof ChartWidget>;

// --------------------------------------------------------------------------------------------- patient widget
export const RiskReason = z.object({
  feature: z.string(),
  label: z.string().nullable().optional(),
  contribution: z.number().nullable().optional(),
  value: z.number().nullable().optional(),
});
export type RiskReason = z.infer<typeof RiskReason>;

export const PatientTimelineEvent = z.object({
  ts: z.string(),
  event_type: z.string(),
  concept_id: z.number().nullable().optional(),
  label: z.string().nullable(),
  value_num: z.number().nullable().optional(),
  value_text: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  is_abnormal: z.boolean().nullable().optional(),
  facility: z.string().nullable().optional(),
  highlight: z.boolean().optional(),
});
export type PatientTimelineEvent = z.infer<typeof PatientTimelineEvent>;

export const SeriesPoint = z.object({ ts: z.string(), value: z.number().nullable() });

export const PatientLab = z.object({
  concept_id: z.number(),
  name: z.string(),
  unit: z.string().nullable().optional(),
  latest: z.union([z.number(), z.string()]).nullable(),
  latest_ts: z.string().nullable(),
  abnormal: z.boolean(),
  change_pct_12m: z.number().nullable().optional(),
  n: z.number(),
  coded: z.boolean().optional(),
});
export type PatientLab = z.infer<typeof PatientLab>;

export const PatientAlert = z.object({
  alert_id: z.string(),
  trigger: z.string(),
  severity: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  suggested_action: z.string().nullable(),
  created_at: z.string().nullable(),
});
export type PatientAlert = z.infer<typeof PatientAlert>;

export const PatientWidget = z.object({
  kind: z.literal("patient"),
  id: z.string(),
  patient_id: z.number(),
  display_id: z.string().nullable(),
  /**
   * Full name for the clinician's screen. Present in the UI payload only: the agent's tools strip it from the
   * model-visible view (toModelOutput), so the remote model never receives patient names.
   */
  name: z.string().nullable().optional(),
  sex: z.string().nullable(),
  age: z.number().nullable(),
  district_name: z.string().nullable().optional(),
  home_facility_name: z.string().nullable().optional(),
  is_case: z.boolean().nullable(),
  case_status: z.string().nullable().optional(),
  dx_date: z.string().nullable().optional(),
  last_visit: z.string().nullable().optional(),
  risk: z
    .object({
      band: z.string().nullable(),
      probability: z.number().nullable(),
      t1_score: z.number().nullable().optional(),
      rank_in_facility: z.number().nullable().optional(),
      as_of: z.string().nullable().optional(),
      scoped_since_flag: z.boolean().nullable().optional(),
      first_high_at: z.string().nullable().optional(),
      top_reasons: z.array(RiskReason),
    })
    .nullable(),
  risk_history: z.array(
    z.object({ as_of: z.string(), ensemble_prob: z.number().nullable(), risk_band: z.string().nullable() }),
  ),
  timeline: z.object({
    window: z.object({ start: z.string(), end: z.string(), months: z.number() }),
    events: z.array(PatientTimelineEvent),
    series: z.object({ hb: z.array(SeriesPoint), weight: z.array(SeriesPoint) }),
  }),
  labs: z.array(PatientLab),
  alerts: z.array(PatientAlert),
  suggested_actions: z.array(z.string()),
  focus: z.string().optional().describe("Why the agent is showing this patient (one line)"),
  links: z.object({ case: z.string(), api: z.string() }),
});
export type PatientWidget = z.infer<typeof PatientWidget>;

// --------------------------------------------------------------------------------------------- sandbox artifacts
export const ArtifactFile = z.object({
  name: z.string(),
  url: z.string().describe("Relative URL served by the agent: /agent/artifacts/<run>/<file>"),
  mime: z.string(),
  kind: z.enum(["image", "html", "csv", "json", "text"]),
  bytes: z.number(),
});
export type ArtifactFile = z.infer<typeof ArtifactFile>;

export const ArtifactSpec = z.object({
  kind: z.literal("artifact"),
  id: z.string(),
  run: z.string(),
  ok: z.boolean(),
  title: z.string().optional(),
  files: z.array(ArtifactFile),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number(),
  rows_in: z.number().describe("Rows handed to the script as `df`"),
  network_isolated: z.boolean(),
});
export type ArtifactSpec = z.infer<typeof ArtifactSpec>;

// --------------------------------------------------------------------------------------------- data videos (v3)
export const VideoKind = z.enum(["patient", "ministry", "ministry_vertical"]);
export type VideoKind = z.infer<typeof VideoKind>;
export const VideoStatus = z.enum(["queued", "rendering", "done", "error"]);
export type VideoStatus = z.infer<typeof VideoStatus>;

/**
 * Output of create_video: a render job on the video server (video/, Remotion). URLs are relative (`/video/...`, proxied
 * by Vite); the UI polls `status_url` until `status` is done, then shows the poster, a player and a download link.
 * Patient videos carry the display ID only (never a name).
 */
export const VideoWidget = z.object({
  kind: z.literal("video"),
  id: z.string(),
  job_id: z.string(),
  video_kind: VideoKind,
  title: z.string(),
  subtitle: z.string().optional(),
  status: VideoStatus,
  progress: z.number().min(0).max(1).optional(),
  cached: z.boolean().optional(),
  url: z.string().nullable(),
  poster_url: z.string().nullable(),
  download_url: z.string().nullable().optional(),
  status_url: z.string().describe("GET this for {status, progress, url, poster_url, download_url, error}"),
  error: z.string().nullable().optional(),
});
export type VideoWidget = z.infer<typeof VideoWidget>;

export const Widget = z.discriminatedUnion("kind", [ChartWidget, PatientWidget, ArtifactSpec, VideoWidget]);
export type Widget = z.infer<typeof Widget>;

// --------------------------------------------------------------------------------------------- chat contract
export const Role = z.enum(["ministry", "doctor"]);
export type Role = z.infer<typeof Role>;

/** `message.metadata` on assistant UI messages (sent on stream start/finish, persisted with the message). */
export const MessageMetadata = z.object({
  run_id: z.union([z.number(), z.string()]).nullable().optional(),
  sim_time: z.string().nullable().optional(),
  model: z.string().optional(),
  role: Role.optional(),
  facility_id: z.number().nullable().optional(),
  created_at: z.string().optional(),
  finished_at: z.string().optional(),
  validated_numbers: z.boolean().nullable().optional(),
  unsupported_numbers: z.array(z.number()).optional(),
  tools_called: z.array(z.string()).optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .partial()
    .optional(),
  finish_reason: z.string().optional(),
});
export type MessageMetadata = z.infer<typeof MessageMetadata>;

/** Tool names per agent (chat UI shows friendly labels; evals assert expected tools). */
export const MINISTRY_TOOLS = [
  "describe_tables",
  "query_marts",
  "get_kpis",
  "get_rates_trend",
  "get_district_ranking",
  "get_care_cascade",
  "get_stage_mix",
  "get_survival",
  "get_facility_quality",
  "get_model_metrics",
  "get_care_funnel",
  "get_forecast",
  "run_forecast_scenario",
  "get_model_monitoring",
  "make_chart",
  "create_video",
  "run_python",
] as const;
export const DOCTOR_TOOLS = [
  "describe_tables",
  "query_marts",
  "get_model_metrics",
  "get_patient",
  "get_patient_timeline",
  "get_patient_risk",
  "list_high_risk_patients",
  "list_alerts",
  "get_care_plan",
  "list_followups",
  "get_patient_journey",
  "draft_care_plan",
  "make_chart",
  "make_patient_widget",
  "create_video",
  "run_python",
] as const;
export type MinistryToolName = (typeof MINISTRY_TOOLS)[number];
export type DoctorToolName = (typeof DOCTOR_TOOLS)[number];
export type ToolName = MinistryToolName | DoctorToolName;

export const TOOL_LABELS: Record<ToolName, string> = {
  describe_tables: "Reading the data dictionary",
  query_marts: "Querying the data marts",
  get_kpis: "Loading headline indicators",
  get_rates_trend: "Loading incidence trend",
  get_district_ranking: "Ranking districts",
  get_care_cascade: "Loading the care cascade",
  get_stage_mix: "Loading stage at diagnosis",
  get_survival: "Loading survival",
  get_facility_quality: "Loading facility quality",
  get_model_metrics: "Loading model performance",
  get_patient: "Opening patient record",
  get_patient_timeline: "Reading patient timeline",
  get_patient_risk: "Reading risk history",
  list_high_risk_patients: "Listing high-risk patients",
  list_alerts: "Loading alerts",
  make_chart: "Drawing chart",
  make_patient_widget: "Preparing patient card",
  run_python: "Running analysis in the sandbox",
  get_care_funnel: "Loading the care coordination funnel",
  get_forecast: "Loading the incidence forecast",
  run_forecast_scenario: "Running a forecast scenario",
  get_model_monitoring: "Checking the learning loop",
  get_care_plan: "Reading the care plan",
  list_followups: "Loading follow-ups",
  get_patient_journey: "Reading the patient journey",
  draft_care_plan: "Drafting a care plan for approval",
  create_video: "Starting the video render",
};

/** Tools that only read or draft. No agent tool creates care plans, changes tasks or sends patient notifications:
 * the doctor approves plans in the UI (evals assert that these names never appear). */
export const FORBIDDEN_ACTION_TOOLS = ["create_care_plan", "approve_care_plan", "send_notification", "notify_patient", "patch_task"] as const;
