/** get_patient_risk: port of GET /patients/{id}/risk (current score, history, thresholds). */
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { notFound, patientRisk, PatientRef, resolvePatient } from "./patient.js";
import { round } from "./rates.js";
import { defineTool } from "./types.js";

export const getPatientRisk = defineTool({
  name: "get_patient_risk",
  title: "Patient risk",
  description:
    "Current gastric cancer risk of one patient (risk_band, risk_pct, tier scores, top_reasons with SHAP contributions, " +
    "scoped_since_flag, first_high_at) plus the monthly risk history (as_of, ensemble_prob, risk_band) and the band thresholds. " +
    "`rows` (dataset_id) is the history for a line chart.",
  roles: ["doctor"],
  inputSchema: z.object(PatientRef),
  async execute(ref, t) {
    try {
      const pid = await resolvePatient(t, ref);
      const db = SERVE();
      const current = await patientRisk(pid);
      const history = (await db.hasTable("ml_risk_history"))
        ? (await db.rows("SELECT as_of, t1_score, t2_prob, t3_prob, ensemble_prob, risk_band FROM ml_risk_history WHERE patient_id = ? ORDER BY as_of", [pid]))
            .map((r) => ({ ...r, ensemble_prob: round(r.ensemble_prob, 4), risk_pct: typeof r.ensemble_prob === "number" ? round(100 * r.ensemble_prob, 1) : null, t2_prob: round(r.t2_prob, 4), t3_prob: round(r.t3_prob, 4) }))
        : [];
      const thresholds = (await db.hasTable("ml_thresholds")) ? await db.one("SELECT high_cut, medium_cut FROM ml_thresholds") : null;
      return { ok: true, patient_id: pid, current, thresholds, dataset_id: t.datasets.register("get_patient_risk", history), rows: history };
    } catch (e) {
      return notFound(e);
    }
  },
});
