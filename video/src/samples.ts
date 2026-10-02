/** Small fictional props for Remotion Studio previews (not from the API, no real or synthetic patient). */
import type { MinistryReelProps, PatientVideoProps } from "./props";

export const SAMPLE_PATIENT: PatientVideoProps = {
  display_id: "DEMO-0000001X", facility: "Demo Health Centre (Synthetic)", sim_date: "2026-06-30", synthetic: true,
  risk: { t1_score: 11, t2_prob: 0.42, ensemble_prob: 0.45, band: "HIGH", t1_band: "HIGH", thresholds: { medium: 0.06, high: 0.32 },
    top_reasons: [
      { label: "Haemoglobin fell 2.1 g/dL in 12 months", value: 0.9, direction: "up" },
      { label: "Age 61", value: 0.5, direction: "up" },
      { label: "4 visits with stomach complaints in 6 months", value: 0.3, direction: "up" },
      { label: "Recent H. pylori treatment", value: -0.12, direction: "down" },
    ] },
  organs: [
    { id: "stomach", label: "Stomach", score: 0.72, conditions: [{ name: "Dyspepsia", date: "2026-05-28", severity: 0.6 }, { name: "Early satiety", date: "2026-06-12", severity: 0.5 }], labs: [] },
    { id: "vessels", label: "Blood vessels", score: 0.65, conditions: [{ name: "Haemoglobin", date: "2026-06-12", severity: 0.65 }],
      labs: [{ name: "Haemoglobin", unit: "g/dL", low: 13, high: 17, series: [{ date: "2025-06-01", value: 13.4 }, { date: "2025-12-01", value: 12.1 }, { date: "2026-06-12", value: 11.3 }] }] },
  ],
  timeline: [
    { date: "2025-03-02", type: "Visit", label: "Follow-up visit", organ_ids: [] },
    { date: "2025-09-10", type: "Symptom", label: "Epigastric pain", organ_ids: ["stomach"] },
    { date: "2026-05-28", type: "Diagnosis", label: "Dyspepsia", organ_ids: ["stomach"] },
    { date: "2026-06-12", type: "Lab", label: "Haemoglobin", organ_ids: ["vessels"], abnormal: true },
  ],
  care: null, journey: null, tumour: null, alerts: [], next_step: "Refer for endoscopy",
};

export const SAMPLE_MINISTRY: MinistryReelProps = {
  period: { from: 2016, to: 2025 }, filters: { sex: "ALL", age: "ALL", def: "CONFIRMED_PROBABLE" },
  kpis: [
    { label: "Cases, 2025", value: 280, unit: "", delta: 6.1, delta_label: "vs 2024" },
    { label: "Age-standardised rate", value: 31.2, unit: "per 100,000", delta: 4.2, delta_label: "vs 2024", decimals: 1 },
    { label: "Diagnosed at stage IV", value: 48, unit: "%", delta: -2, delta_label: "vs 2024" },
  ],
  national_asr: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((year, i) => ({ year, value: 22 + i, lo: 19 + i, hi: 25 + i })),
  joinpoint: { year: 2020, apc_before: 2.1, apc_after: 5.4 }, districts: [], geo: null, hotspots: [],
  young_onset: [2016, 2018, 2020, 2022, 2024].map((year, i) => ({ year, value: 5 + i })), cascade: [{ step: "Flagged", n: 1000 }, { step: "Referred", n: 300 }, { step: "Diagnosed", n: 90 }],
  stage_mix: [{ year: 2016, I: 10, II: 20, III: 25, IV: 45 }, { year: 2025, I: 18, II: 24, III: 22, IV: 36 }],
  care: null, forecast: null, models: { auroc: 0.9, auprc: 0.3, ppv: 0.4 }, messages: ["Incidence rose 40% from 2016 to 2025."],
};
