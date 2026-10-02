/** Typed props for the Early Signals data videos (contract docs/contracts/v3-loop.md §8).
 *
 * The frontend imports this file through the `@video` alias, so it must stay free of Node imports. zod objects strip
 * unknown keys, so parsing is also the final whitelist: nothing outside these shapes (names, birthdates, phone numbers)
 * reaches a composition. Fields marked "extra" are optional additions to the frozen contract (backward compatible). */
import { z } from "zod";

const num = z.number();
const nnum = z.number().nullable();
const date = z.string(); // ISO date or datetime (sim time)

// ------------------------------------------------------------------------------------------------ patient
export const ReasonSchema = z.object({
  label: z.string(),
  value: num, // contribution (log-odds units for tier 2)
  direction: z.enum(["up", "down"]),
});

export const LabSchema = z.object({
  name: z.string(),
  unit: z.string().nullable(),
  series: z.array(z.object({ date, value: num })),
  low: nnum,
  high: nnum,
});

export const OrganSchema = z.object({
  id: z.string(),
  label: z.string(),
  score: num,
  conditions: z.array(z.object({ name: z.string(), date, severity: num })),
  labs: z.array(LabSchema),
});

export const TimelineItemSchema = z.object({
  date,
  type: z.string(),
  label: z.string(),
  organ_ids: z.array(z.string()),
  abnormal: z.boolean().optional(), // extra
});

export const CareTaskSchema = z.object({
  title: z.string(),
  status: z.string(),
  due: date.nullable(),
  completed: date.nullable(),
});
export const CareSchema = z.object({
  plans: z.array(z.object({ pathway: z.string(), status: z.string(), tasks: z.array(CareTaskSchema) })),
});

const SeriesPoint = z.object({ date, value: num });
export const JourneySchema = z.object({
  phases: z.array(z.object({
    phase: z.string(),
    start: date.nullable(),
    end: date.nullable(),
    status: z.string(),
    milestones: z.array(z.object({ date, label: z.string(), kind: z.string().nullable() })).default([]),
  })),
  recovery: z.object({
    series: z.record(z.string(), z.array(SeriesPoint)).default({}),
    chemo: z.object({ done: nnum, planned: nnum }).nullable().default(null),
    next_visit: date.nullable().default(null),
    missed_visits: nnum.default(null),
    recurrence: z.string().nullable().default(null),
  }).nullable(),
});

export const TumourSchema = z.object({
  stage_group: z.string().nullable(),
  t_stage: z.string().nullable(),
  n_stage: z.string().nullable(),
  m_stage: z.string().nullable(),
  lesion_location: z.string().nullable(),
  dx_date: date.nullable(),
  histology: z.string().nullable(),
});

export const PatientVideoPropsSchema = z.object({
  display_id: z.string(),
  facility: z.string(),
  sim_date: date,
  synthetic: z.literal(true),
  risk: z.object({
    t1_score: nnum,
    t2_prob: nnum,
    ensemble_prob: nnum,
    band: z.string(),
    top_reasons: z.array(ReasonSchema),
    t1_band: z.string().nullable().optional(), // extra
    thresholds: z.object({ medium: nnum, high: nnum }).nullable().optional(), // extra: ensemble cut-offs
  }),
  organs: z.array(OrganSchema),
  timeline: z.array(TimelineItemSchema),
  care: CareSchema.nullable(),
  journey: JourneySchema.nullable(),
  tumour: TumourSchema.nullable(),
  alerts: z.array(z.object({ trigger: z.string(), severity: z.string(), summary: z.string() })).optional(), // extra
  next_step: z.string().nullable().optional(), // extra: the alert's suggested action
});
export type PatientVideoProps = z.infer<typeof PatientVideoPropsSchema>;

// ------------------------------------------------------------------------------------------------ ministry
const YearValue = z.object({ year: num, value: nnum });

export const GeoSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.object({
    type: z.literal("Feature"),
    properties: z.object({ code: z.string(), name: z.string() }),
    geometry: z.object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.any() }),
  })),
});

export const ForecastPointSchema = z.object({
  year: num, value: nnum, lo80: nnum.optional(), hi80: nnum.optional(), lo95: nnum.optional(), hi95: nnum.optional(),
});

export const MinistryReelPropsSchema = z.object({
  period: z.object({ from: num, to: num }),
  filters: z.object({ sex: z.string(), age: z.string(), def: z.string() }),
  kpis: z.array(z.object({
    label: z.string(), value: nnum, unit: z.string(), delta: nnum,
    delta_label: z.string().optional(), // extra, e.g. "vs 2025"
    higher_is_better: z.boolean().optional(), // extra
    spark: z.array(nnum).optional(), // extra
    decimals: z.number().optional(), // extra
  })),
  national_asr: z.array(z.object({ year: num, value: nnum, lo: nnum, hi: nnum })),
  joinpoint: z.object({
    year: nnum, apc_before: nnum, apc_after: nnum,
    fitted: z.array(YearValue).optional(), // extra: fitted joinpoint line
    aapc: nnum.optional(), // extra
  }).nullable(),
  districts: z.array(z.object({ code: z.string(), name: z.string(), values_by_year: z.record(z.string(), nnum) })),
  geo: GeoSchema.nullable(),
  hotspots: z.array(z.string()),
  map_label: z.string().optional(), // extra: what the choropleth shows
  smoothed: z.object({ label: z.string(), values: z.record(z.string(), nnum) }).nullable().optional(), // extra: pooled EB map
  young_onset: z.array(YearValue),
  young_onset_label: z.string().optional(), // extra
  cascade: z.array(z.object({ step: z.string(), n: nnum })),
  stage_mix: z.array(z.object({ year: num, I: nnum, II: nnum, III: nnum, IV: nnum })),
  stage_mix_label: z.string().optional(), // extra
  care: z.object({
    funnel: z.array(z.object({ step: z.string(), n: nnum })),
    adherence: z.array(z.object({ group: z.string(), value: nnum })),
    adherence_label: z.string().optional(),
  }).nullable(),
  forecast: z.object({
    history: z.array(ForecastPointSchema),
    forecast: z.array(ForecastPointSchema),
    label: z.string().optional(),
  }).nullable(),
  models: z.object({
    auroc: nnum, auprc: nnum, ppv: nnum,
    sens_at_spec90: nnum.optional(), lead_time_days: nnum.optional(), name: z.string().optional(), // extras
  }).nullable(),
  messages: z.array(z.string()),
  sim_date: date.optional(), // extra
});
export type MinistryReelProps = z.infer<typeof MinistryReelPropsSchema>;

export type VideoKind = "patient" | "ministry" | "ministry_vertical";
export const COMPOSITION_FOR: Record<VideoKind, "PatientCaseSummary" | "MinistryReel" | "MinistryReelVertical"> = {
  patient: "PatientCaseSummary",
  ministry: "MinistryReel",
  ministry_vertical: "MinistryReelVertical",
};

/** Keys that must never appear anywhere in patient props (checked by the props builder and the server). */
export const FORBIDDEN_KEYS = ["given_name", "family_name", "birthdate", "phone", "name_full", "patient_name"];
