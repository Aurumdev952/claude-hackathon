"""Deterministic question -> SQL rules (used by the `template` provider and as few-shot examples for LLMs)."""
from __future__ import annotations

import re

from shared.geo import DISTRICTS, PROVINCES

DEFAULTS = "sex = 'ALL' AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'"
PROV_NAMES = {"kigali": "KGL", "northern": "NOR", "north": "NOR", "southern": "SOU", "south": "SOU", "eastern": "EAS",
              "east": "EAS", "western": "WES", "west": "WES"}


def _year(q, default="2025"):
    m = re.findall(r"\b(20[12]\d)\b", q)
    return m[0] if m else default


def _years(q):
    return re.findall(r"\b(20[12]\d)\b", q)


def _n(q, default=5):
    m = re.search(r"\b(top|highest|lowest|first)\s+(\d+)\b|\b(\d+)\s+(highest|lowest|districts|facilities|patients)", q)
    if m:
        return int(m.group(2) or m.group(3))
    return default


def _district(q):
    for code, (_, name, _) in DISTRICTS.items():
        if name.lower() in q:
            return code
    return None


def _province(q):
    for k, v in PROV_NAMES.items():
        if re.search(rf"\b{k}\b", q):
            return v
    return None


def _band(q):
    if re.search(r"under[- ]?50|<\s*50|young", q):
        return "<50"
    if re.search(r"50\s*-\s*64|50 to 64", q):
        return "50-64"
    if re.search(r"65\+|over 65|older than 65|65 and over", q):
        return "65+"
    return "ALL"


def match(question: str, role: str, facility_id: int | None, last_full_year: int) -> tuple[str, str] | None:
    """Returns (intent, sql) or None."""
    q = question.lower().strip()
    if re.search(r"\b(delete|drop|update|insert|truncate|alter|grant|attach)\b", q):
        return ("refuse", "")
    band = _band(q)
    lf = str(last_full_year)
    if role == "doctor":
        f = int(facility_id)
        scope = f"patient_id IN (SELECT patient_id FROM pt_patient_facility WHERE facility_id = {f})"
        if re.search(r"(high[- ]risk|highest[- ]risk).*(not been scoped|not scoped|without endoscopy|awaiting)", q):
            return ("patients", f"SELECT count(*) AS high_risk_not_scoped FROM pt_risk WHERE risk_band = 'HIGH' "
                                f"AND NOT scoped_since_flag AND {scope}")
        if re.search(r"highest[- ]risk|top .*patients|my \d+ ", q):
            n = _n(q, 10)
            return ("patients", f"SELECT p.display_id, p.given_name || ' ' || p.family_name AS name, p.age, r.risk_band, "
                                f"round(100 * r.ensemble_prob, 1) AS risk_pct FROM pt_risk r JOIN pt_patient p USING (patient_id) "
                                f"WHERE r.{scope} ORDER BY r.ensemble_prob DESC LIMIT {n}")
        if re.search(r"pylori|hp\b", q) and re.search(r"no treatment|untreated|not treated|without treatment", q):
            return ("patients", f"SELECT p.display_id, p.given_name || ' ' || p.family_name AS name, a.created_at, a.summary "
                                f"FROM pt_alerts a JOIN pt_patient p USING (patient_id) WHERE a.\"trigger\" = 'HP_POS_UNTREATED' "
                                f"AND a.{scope} ORDER BY a.created_at DESC LIMIT 100")
    if re.search(r"auroc|compare .*models|model performance", q):
        return ("models", "SELECT model_id, tier, round(auroc, 3) AS auroc, round(auprc, 3) AS auprc, median_lead_time_days "
                          "FROM ml_eval_metrics WHERE split = 'test' ORDER BY tier")
    if re.search(r"high[- ]high|hotspot", q):
        return ("geography", "SELECT s.district_code AS geo_code, d.name, round(s.asr, 1) AS asr, round(s.sir, 2) AS sir, s.lisa_quadrant "
                             "FROM mart_spatial s JOIN ref_district d USING (district_code) WHERE s.lisa_quadrant = 'HH' ORDER BY s.asr DESC")
    if re.search(r"(1|one)[- ]year survival|survival by stage", q):
        return ("survival", "SELECT group_value AS stage, round(100 * surv_1y, 1) AS surv_1y_pct, n FROM mart_survival_summary "
                            "WHERE group_var = 'stage' ORDER BY group_value")
    if re.search(r"diagnostic interval", q):
        gv = "province" if "province" in q else ("tier" if "tier" in q or "facilit" in q else ("age_band" if "age" in q else "province"))
        return ("warning_signs", f"SELECT \"group\", round(median_days / 30.44, 1) AS median_months, n FROM mart_diag_interval "
                                 f"WHERE group_var = '{gv}' ORDER BY median_days DESC")
    if re.search(r"(3|three) or more gi visits|>= ?3 gi|three or more visits|visits before diagnosis", q):
        return ("warning_signs", "SELECT metric, round(\"case\", 1) AS cases_pct, round(control, 1) AS controls_pct FROM mart_warning_summary "
                                 "WHERE metric = 'pct_ge3_gi_visits_24m'")
    if re.search(r"awaiting endoscopy|high[- ]risk patients", q):
        return ("kpis", "SELECT year, high_risk_awaiting_endoscopy FROM mart_kpis ORDER BY year DESC LIMIT 1")
    if re.search(r"diffuse", q):
        return ("characteristics", "SELECT \"group\", round(pct, 1) AS pct_diffuse, n FROM mart_characteristics "
                                   "WHERE variable = 'lauren' AND level = 'Diffuse' ORDER BY \"group\"")
    if re.search(r"stage iv|stage 4|late stage", q) and "province" in q:
        return ("rates", "SELECT m.geo_code, p.name, round(m.pct_known, 1) AS pct_stage_iv, m.n FROM mart_stage_mix m "
                         "JOIN ref_province p ON p.province_code = m.geo_code WHERE m.level = 'PROVINCE' AND m.year = 'ALL' "
                         "AND m.facility_tier = 'ALL' AND m.stage_group = 'IV' ORDER BY m.pct_known DESC")
    if re.search(r"pylori|hp test", q) and re.search(r"fewest|lowest|below|least", q):
        thr = re.search(r"below (\d+(?:\.\d+)?)\s*%", q)
        where = f" AND hp_test_rate < {float(thr.group(1)) / 100}" if thr else ""
        return ("facilities", f"SELECT name, district_code, round(100 * hp_test_rate, 1) AS hp_test_rate_pct, n_dyspepsia "
                              f"FROM mart_facility_quality WHERE n_dyspepsia >= 10{where} ORDER BY hp_test_rate ASC LIMIT {_n(q, 10)}")
    if re.search(r"\bapc\b|annual percent", q):
        sid = f"NATIONAL|ALL|{band}|CONFIRMED_PROBABLE"
        return ("trends", f"SELECT series_id, segment_no, start_year, end_year, round(apc, 1) AS apc, round(apc_lci, 1) AS apc_lci, "
                          f"round(apc_uci, 1) AS apc_uci, significant FROM mart_joinpoint WHERE series_id = '{sid}' "
                          f"ORDER BY segment_no DESC LIMIT 1")
    d = _district(q)
    if d and re.search(r"crude", q) and re.search(r"asr|age[- ]standardi[sz]ed|adjusted", q):
        y = _year(q, lf)
        return ("rates", f"SELECT geo_code, period, round(crude_rate, 1) AS crude_rate, round(asr, 1) AS asr, cases FROM mart_rates "
                         f"WHERE level = 'DISTRICT' AND geo_code = '{d}' AND period = '{y}' AND {DEFAULTS}")
    if d and re.search(r"change|after|since|before|trend", q):
        return ("trends", f"SELECT CAST(period AS INTEGER) AS year, cases, round(asr, 1) AS asr FROM mart_rates WHERE level = 'DISTRICT' "
                          f"AND geo_code = '{d}' AND period_type = 'YEAR' AND {DEFAULTS} AND NOT partial_year AND coverage_flag IS NULL ORDER BY 1")
    p = _province(q)
    if p and re.search(r"how many|number of|cases", q):
        cd = "CONFIRMED" if "confirmed" in q else "CONFIRMED_PROBABLE"
        return ("rates", f"SELECT geo_code, period, cases FROM mart_rates WHERE level = 'PROVINCE' AND geo_code = '{p}' "
                         f"AND period = '{_year(q, lf)}' AND sex = 'ALL' AND age_band = 'ALL' AND case_def = '{cd}'")
    if re.search(r"male.*female|female.*male|by sex|men.*women", q):
        return ("rates", f"SELECT sex, round(asr, 1) AS asr, cases FROM mart_rates WHERE level = 'NATIONAL' AND period = '{_year(q, lf)}' "
                         f"AND sex IN ('M', 'F') AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE' ORDER BY sex")
    if re.search(r"changed since|trend|over time|since 20", q):
        y0 = _years(q)[0] if _years(q) else "2015"
        return ("trends", f"SELECT CAST(period AS INTEGER) AS year, round(asr, 1) AS asr, cases FROM mart_rates WHERE level = 'NATIONAL' "
                          f"AND period_type = 'YEAR' AND sex = 'ALL' AND age_band = '{band}' AND case_def = 'CONFIRMED_PROBABLE' "
                          f"AND CAST(period AS INTEGER) BETWEEN {y0} AND {lf} ORDER BY 1")
    if re.search(r"district", q) and re.search(r"highest|top|most|worst", q):
        n = _n(q, 5)
        yrs = _years(q)
        if re.search(r"last (3|three) years|pooled|2023[- ]2025", q) or len(yrs) >= 2:
            per = f"{int(lf) - 2}-{lf}" if len(yrs) < 2 else f"{yrs[0]}-{yrs[1]}"
            cond = f"period = '{per}'"
        else:
            cond = f"period = '{_year(q, lf)}'"
        return ("geography", f"SELECT r.geo_code, d.name, round(r.asr, 1) AS asr, r.cases FROM mart_rates r "
                             f"JOIN ref_district d ON d.district_code = r.geo_code WHERE r.level = 'DISTRICT' AND {cond} "
                             f"AND r.sex = 'ALL' AND r.age_band = '{band}' AND r.case_def = 'CONFIRMED_PROBABLE' ORDER BY r.asr DESC LIMIT {n}")
    if re.search(r"national|country|rwanda|overall", q) and re.search(r"rate|asr|incidence", q):
        return ("rates", f"SELECT period, round(asr, 1) AS asr, round(asr_lci, 1) AS asr_lci, round(asr_uci, 1) AS asr_uci, cases "
                         f"FROM mart_rates WHERE level = 'NATIONAL' AND period = '{_year(q, lf)}' AND sex = 'ALL' "
                         f"AND age_band = '{band}' AND case_def = 'CONFIRMED_PROBABLE'")
    return None
