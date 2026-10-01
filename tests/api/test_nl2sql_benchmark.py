"""NL->SQL benchmark (SPEC §19.5): 20 questions, >= 18 must be answered correctly.

Runs in template mode (LLM_PROVIDER=template, no model needed). A question is correct when every value returned by
the independent reference SQL appears in the answer's rows (strings exactly, numbers within 0.1), and the answer
has no extra rows beyond the reference row count (top-N questions). Q20 is correct when the request is refused.
"""
from __future__ import annotations

import os

import pytest

from shared.config import ANALYTICS_DIR

P = "sex = 'ALL' AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'"

BENCH = [
    ("National ASR in 2024.", "ministry",
     f"SELECT asr FROM mart_rates WHERE level = 'NATIONAL' AND period = '2024' AND {P}"),
    ("Top 5 districts by ASR, 2023-2025 pooled.", "ministry",
     f"SELECT geo_code FROM mart_rates WHERE level = 'DISTRICT' AND period = '2023-2025' AND {P} ORDER BY asr DESC LIMIT 5"),
    ("Under-50 ASR trend since 2015.", "ministry",
     "SELECT asr FROM mart_rates WHERE level = 'NATIONAL' AND period_type = 'YEAR' AND sex = 'ALL' AND age_band = '<50' "
     "AND case_def = 'CONFIRMED_PROBABLE' AND CAST(period AS INTEGER) >= 2015 AND NOT partial_year"),
    ("Male vs female ASR in 2025.", "ministry",
     "SELECT asr FROM mart_rates WHERE level = 'NATIONAL' AND period = '2025' AND sex IN ('M', 'F') AND age_band = 'ALL' "
     "AND case_def = 'CONFIRMED_PROBABLE'"),
    ("Which province has the highest share of stage IV?", "ministry",
     "SELECT geo_code FROM (SELECT geo_code, sum(n) FILTER (WHERE stage_group = 'IV') / sum(n) FILTER (WHERE stage_group <> 'Unknown') s "
     "FROM mart_stage_mix WHERE level = 'PROVINCE' AND facility_tier = 'ALL' GROUP BY 1) ORDER BY s DESC LIMIT 1"),
    ("How many confirmed cases in Western Province in 2024?", "ministry",
     "SELECT cases FROM mart_rates WHERE level = 'PROVINCE' AND geo_code = 'WES' AND period = '2024' AND sex = 'ALL' "
     "AND age_band = 'ALL' AND case_def = 'CONFIRMED'"),
    ("Facilities with HP testing rate below 5%.", "ministry",
     "SELECT name FROM mart_facility_quality WHERE hp_test_rate < 0.05 AND n_dyspepsia >= 10"),
    ("1-year survival by stage.", "ministry",
     "SELECT surv_1y FROM mart_survival_summary WHERE group_var = 'stage'"),
    ("Median diagnostic interval by province.", "ministry",
     "SELECT round(median_days / 30.44, 1) FROM mart_diag_interval WHERE group_var = 'province'"),
    ("Which districts are LISA High-High hotspots?", "ministry",
     "SELECT district_code FROM mart_spatial WHERE lisa_quadrant = 'HH'"),
    ("APC for the national under-50 series after the joinpoint.", "ministry",
     "SELECT apc FROM mart_joinpoint WHERE series_id = 'NATIONAL|ALL|<50|CONFIRMED_PROBABLE' ORDER BY segment_no DESC LIMIT 1"),
    ("Crude rate vs ASR for Nyaruguru in 2024.", "ministry",
     f"SELECT crude_rate, asr FROM mart_rates WHERE level = 'DISTRICT' AND geo_code = 'SOU-NYG' AND period = '2024' AND {P}"),
    ("% of cases with >= 3 GI visits before diagnosis.", "ministry",
     "SELECT \"case\" FROM mart_warning_summary WHERE metric = 'pct_ge3_gi_visits_24m'"),
    ("How did Rusizi's diagnoses change after 2021?", "ministry",
     f"SELECT cases FROM mart_rates WHERE level = 'DISTRICT' AND geo_code = 'WES-RUS' AND period_type = 'YEAR' AND {P} "
     "AND CAST(period AS INTEGER) BETWEEN 2019 AND 2025"),
    ("Compare AUROC of the three models.", "ministry",
     "SELECT auroc FROM ml_eval_metrics WHERE split = 'test'"),
    ("Share of young-onset cases that are diffuse type.", "ministry",
     "SELECT pct FROM mart_characteristics WHERE variable = 'lauren' AND level = 'Diffuse' AND \"group\" = '<50'"),
    ("Number of high-risk patients awaiting endoscopy (national).", "ministry",
     "SELECT high_risk_awaiting_endoscopy FROM mart_kpis ORDER BY year DESC LIMIT 1"),
    ("My 10 highest-risk patients.", "doctor",
     "SELECT r.patient_id FROM pt_risk r JOIN pt_patient_facility f USING (patient_id) WHERE f.facility_id = {fac} "
     "ORDER BY r.ensemble_prob DESC LIMIT 10"),
    ("Patients with HP positive and no treatment.", "doctor", None),
    ("Delete all patients", "ministry", "REFUSE"),
]


@pytest.fixture(scope="module")
def env():
    if not (ANALYTICS_DIR / "current.json").exists():
        pytest.skip("no published serve DB")
    os.environ["LLM_PROVIDER"] = "template"
    from api.deps import SERVE
    SERVE.refresh()
    fac = SERVE.one("""SELECT f.facility_id FROM pt_patient_facility f JOIN pt_risk r USING (patient_id)
                       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1""") if SERVE.has_table("pt_risk") else None
    return SERVE, (fac or {}).get("facility_id")


def _close(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 0.1 or (abs(b) > 0 and abs(a / b - 1) < 1e-3) or abs(100 * a - b) <= 0.1 or abs(a - 100 * b) <= 0.1
    return str(a).strip().lower() == str(b).strip().lower()


def grade(serve, fac, q, role, ref) -> tuple[bool, str]:
    from api.llm.nl2sql import ask
    out = ask(q, role, fac)
    if ref == "REFUSE":
        return bool(out.get("refused")) and not out.get("rows"), "refusal"
    if ref is None:  # doctor-only cohort question: must run, return rows scoped to the facility
        ok = bool(out.get("sql")) and out.get("error") is None
        if ok and out["rows"] and "patient_id" in out["columns"]:
            allowed = {r["patient_id"] for r in serve.rows("SELECT patient_id FROM pt_patient_facility WHERE facility_id = ?", [fac])}
            ok = {r[out["columns"].index("patient_id")] if isinstance(r, list) else r["patient_id"] for r in out["rows"]} <= allowed
        return ok, out.get("sql") or ""
    try:
        ref_rows = serve.rows(ref.format(fac=fac))
    except Exception as e:  # e.g. models not trained -> the question cannot be scored
        return False, f"reference unavailable: {e.__class__.__name__}"
    if not out.get("rows"):
        return False, f"no rows; sql={out.get('sql')} err={out.get('error')}"
    rows = [r if isinstance(r, list) else list(r.values()) for r in out["rows"]]
    values = [v for r in rows for v in r]
    missing = [v for rr in ref_rows for v in rr.values() if v is not None and not any(_close(x, v) for x in values)]
    too_many = "LIMIT" in ref.upper() and len(rows) > len(ref_rows)
    return (not missing and not too_many), f"missing={missing[:4]} rows={len(rows)} sql={out.get('sql')}"


def test_benchmark_score(env):
    serve, fac = env
    results = []
    for i, (q, role, ref) in enumerate(BENCH, 1):
        if role == "doctor" and fac is None:
            results.append((i, False, "no scored patients"))
            continue
        ok, why = grade(serve, fac if role == "doctor" else None, q, role, ref)
        results.append((i, ok, why))
    score = sum(ok for _, ok, _ in results)
    report = "\n".join(f"Q{i:02d} {'PASS' if ok else 'FAIL'} {why if not ok else ''}" for i, ok, why in results)
    print(f"\nNL->SQL benchmark: {score}/20\n{report}")
    assert score >= 18, report
