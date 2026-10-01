/** Semantic layer (api/llm/semantic_layer.yaml, the single source shared with the FastAPI Ask-the-Data). */
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { config } from "../config.js";
import type { Role } from "../context.js";

export interface TableDoc {
  description?: string;
  grain?: string;
  columns?: Record<string, string>;
  default_filters?: string;
}

export interface SemanticLayer {
  tables: Record<string, TableDoc>;
  glossary: Record<string, string>;
  suggested_questions: Record<Role, string[]>;
}

let cached: SemanticLayer | null = null;

export function semantic(): SemanticLayer {
  if (!cached) {
    const raw = YAML.parse(readFileSync(config().semanticLayerPath, "utf8")) as Partial<SemanticLayer>;
    cached = {
      tables: raw.tables ?? {},
      glossary: raw.glossary ?? {},
      suggested_questions: { ministry: [], doctor: [], ...(raw.suggested_questions ?? {}) } as Record<Role, string[]>,
    };
    // agent-specific additions: patient tables that the agent can query (scoped) but the YAML does not describe
    const extra: Record<string, TableDoc> = {
      pt_timeline: { description: "(doctor only) patient events: patient_id, ts, event_type (VISIT DIAGNOSIS SYMPTOM LAB VITAL DRUG ORDER ENDOSCOPY PATHOLOGY STAGING), concept_id, label, value_num, value_text, unit, is_abnormal, facility_id" },
      pt_patient_facility: { description: "(doctor only) which patients a facility may see: patient_id, facility_id" },
      pt_tumour: { description: "(doctor only) diagnosed tumours: patient_id, dx_date, stage_group, lauren, lesion_location, t_stage, n_stage, m_stage, grade, treatment_intent" },
      ml_risk_history: { description: "(doctor only) risk score history: patient_id, as_of, t1_score, t2_prob, t3_prob, ensemble_prob, risk_band" },
    };
    for (const [k, v] of Object.entries(extra)) if (!cached.tables[k]) cached.tables[k] = v;
  }
  return cached;
}

export function suggestions(role: Role): string[] {
  const base = semantic().suggested_questions[role] ?? [];
  const extra: Record<Role, string[]> = {
    ministry: ["Show me the headline indicators for the latest year", "How does stage at diagnosis differ by facility tier?"],
    doctor: ["Show me my highest-risk patient", "Which open alerts need attention this week?"],
  };
  return [...base, ...extra[role].filter((q) => !base.includes(q))];
}
