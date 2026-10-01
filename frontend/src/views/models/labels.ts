/** Short plain-English names for model features (ml/features.py NUMERIC + one-hot CATEGORICAL columns). */
const L: Record<string, string> = {
  age: "Age", sex_male: "Male sex", district_asr_prior: "District cancer rate", home_endoscopy_access: "Endoscopy in home district",
  n_visits_12m: "Clinic visits, 12 mo", n_visits_24m: "Clinic visits, 24 mo", n_gi_visits_6m: "GI visits, 6 mo", n_gi_visits_12m: "GI visits, 12 mo",
  n_gi_visits_24m: "GI visits, 24 mo", gi_visit_accel: "GI visits accelerating", days_since_last_gi_visit: "Days since last GI visit",
  sx_epigastric: "Epigastric pain", sx_vomiting: "Vomiting", sx_dysphagia: "Difficulty swallowing", sx_weight_loss: "Weight loss reported",
  sx_early_satiety: "Early satiety", sx_anorexia: "Loss of appetite", sx_mass: "Abdominal mass", sx_gi_bleed: "GI bleeding",
  n_alarm_features_12m: "Alarm features, 12 mo", hb_last: "Latest haemoglobin", hb_min_12m: "Lowest Hb, 12 mo", hb_slope_12m: "Hb trend",
  n_hb_12m: "Hb tests, 12 mo", hb_drop_12m: "Hb drop, 12 mo", anaemia_flag: "Anaemic", mcv_last: "Latest MCV", ferritin_last: "Latest ferritin",
  albumin_last: "Latest albumin", platelets_last: "Latest platelets", weight_change_pct_6m: "Weight change, 6 mo",
  weight_change_pct_12m: "Weight change, 12 mo", bmi_last: "BMI", n_ppi_courses_12m: "PPI courses, 12 mo", n_antacid_rx_12m: "Antacid Rx, 12 mo",
  iron_rx_12m: "Iron therapy, 12 mo", nsaid_regular: "Regular NSAIDs", ppi_courses_without_resolution: "PPI without resolution",
  hp_tested_ever: "Ever HP tested", hp_positive_ever: "HP positive", hp_pos_untreated: "HP+ untreated", hp_eradicated: "HP eradicated",
  years_since_hp_pos: "Years since HP+", hiv: "HIV (negative control)", diabetes: "Diabetes", hypertension: "Hypertension", ckd: "Chronic kidney disease",
  malaria_dx_12m_while_anaemic: "Anaemia treated as malaria", helminth_dx_12m_while_anaemic: "Anaemia treated as worms", days_in_cohort: "Time in GI cohort",
};
const CAT: Record<string, string> = {
  province_code: "Province", home_facility_tier: "Facility tier", tobacco: "Tobacco", alcohol: "Alcohol", family_hx: "Family history",
  high_salt: "High-salt diet", smoked_food: "Smoked food", cohort_entry_reason: "Cohort entry",
};

export function featureLabel(f: string) {
  if (L[f]) return L[f];
  const [k, v] = f.split("=");
  if (v !== undefined) return `${CAT[k] ?? k}: ${v.toLowerCase().replace(/_/g, " ")}`;
  return f.replace(/_/g, " ");
}
