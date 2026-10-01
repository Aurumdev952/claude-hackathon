"""AI insight cards per view (SPEC §15.3) and 'Explain this patient' (SPEC §15.4).

Cards come from compact fact sheets built from marts (never raw rows). Templates are always produced; when an LLM
provider is configured it may rephrase a card, which is kept only if every number in it appears in the fact sheet."""
from __future__ import annotations

import datetime as dt
import hashlib
import json

from .. import app_state
from ..deps import SERVE
from .guardrails import deidentify, numbers_supported
from .provider import LLMUnavailable, get_provider

DISCLAIMER = "Decision support only - synthetic data."


def _f(v, nd=1):
    return "n/a" if v is None else f"{v:.{nd}f}"


def _jp(series: str):
    rows = SERVE.rows("SELECT * FROM mart_joinpoint WHERE series_id = ? ORDER BY segment_no", [series])
    return rows[-1] if rows and rows[-1]["segment_no"] else None


def fact_sheet(view: str) -> dict:
    k = SERVE.rows("SELECT * FROM mart_kpis ORDER BY year")
    last = next((x for x in reversed(k) if not x["partial_year"]), k[-1] if k else {})
    facts = {"kpi_year": last.get("year"), "cases": last.get("cases"), "cases_delta_pct": last.get("cases_delta_pct"),
             "national_asr": last.get("national_asr"), "asr_lci": last.get("national_asr_lci"), "asr_uci": last.get("national_asr_uci"),
             "pct_stage_iv": last.get("pct_stage_iv"), "median_diag_interval_days": last.get("median_diag_interval_days"),
             "hp_testing_rate": (last.get("hp_testing_rate_dyspepsia") or 0) * 100}
    young = _jp("NATIONAL|ALL|<50|CONFIRMED_PROBABLE")
    old = _jp("NATIONAL|ALL|65+|CONFIRMED_PROBABLE")
    if young:
        facts.update({"young_apc": young["apc"], "young_apc_lci": young["apc_lci"], "young_apc_uci": young["apc_uci"],
                      "young_jp_year": young["start_year"], "young_significant": young["significant"]})
    if old:
        facts["old_apc"] = old["apc"]
    hh = SERVE.rows("""SELECT d.name, s.asr, s.sir FROM mart_spatial s JOIN ref_district d USING (district_code)
                       WHERE s.lisa_quadrant = 'HH' ORDER BY s.asr DESC""")
    facts["hotspots"] = [{"name": x["name"], "asr": x["asr"], "sir": x["sir"]} for x in hh]
    top = SERVE.rows("""SELECT d.name, r.asr, r.asr_lci, r.asr_uci, r.crude_rate, r.period FROM mart_rates r JOIN ref_district d ON d.district_code = r.geo_code
                        WHERE r.level = 'DISTRICT' AND r.period_type = 'POOLED_ALL' AND r.period LIKE '2019-%' AND r.sex = 'ALL'
                        AND r.age_band = 'ALL' AND r.case_def = 'CONFIRMED_PROBABLE' ORDER BY r.asr DESC LIMIT 3""")
    facts["top_districts"] = top
    crude_top = SERVE.rows("""SELECT d.name, r.crude_rate, r.asr FROM mart_rates r JOIN ref_district d ON d.district_code = r.geo_code
                              WHERE r.level = 'DISTRICT' AND r.period_type = 'POOLED_ALL' AND r.period LIKE '2019-%' AND r.sex = 'ALL'
                              AND r.age_band = 'ALL' AND r.case_def = 'CONFIRMED_PROBABLE' ORDER BY r.crude_rate DESC LIMIT 3""")
    facts["crude_top"] = crude_top
    if view in ("warning", "overview", "quality"):
        ws = {x["metric"]: x for x in SERVE.rows("SELECT * FROM mart_warning_summary")}
        facts["pct_ge3_gi_cases"] = (ws.get("pct_ge3_gi_visits_24m") or {}).get("case")
        facts["pct_ge3_gi_controls"] = (ws.get("pct_ge3_gi_visits_24m") or {}).get("control")
        facts["pct_alarm_no_scope"] = (ws.get("pct_alarm45_no_scope_90d") or {}).get("case")
        di = {x["group"]: x for x in SERVE.rows("SELECT * FROM mart_diag_interval WHERE group_var = 'malaria_region'")}
        if "malaria_endemic" in di and "other" in di:
            facts["interval_malaria_months"] = di["malaria_endemic"]["median_days"] / 30.44
            facts["interval_other_months"] = di["other"]["median_days"] / 30.44
    if view in ("quality", "overview"):
        st = {x["facility_tier"]: x for x in SERVE.rows("""SELECT facility_tier, pct_known FROM mart_stage_mix WHERE level = 'NATIONAL'
                                                           AND year = 'ALL' AND stage_group = 'IV' AND facility_tier IN ('low', 'high')""")}
        sv = {x["group_value"]: x for x in SERVE.rows("SELECT * FROM mart_survival_summary WHERE group_var = 'facility_tier'")}
        facts.update({"stage4_low": (st.get("low") or {}).get("pct_known"), "stage4_high": (st.get("high") or {}).get("pct_known"),
                      "surv1_low": (sv.get("low") or {}).get("surv_1y", 0) * 100 if sv.get("low") else None,
                      "surv1_high": (sv.get("high") or {}).get("surv_1y", 0) * 100 if sv.get("high") else None})
        cox = {(x["model_id"], x["term"]): x for x in SERVE.rows("SELECT * FROM mart_cox")}
        e = cox.get(("eradication_ins4", "eradicated"))
        h = cox.get(("hiv_negative_control", "hiv"))
        if e:
            facts.update({"erad_hr": e["hr"], "erad_lci": e["lci"], "erad_uci": e["uci"]})
        if h:
            facts.update({"hiv_hr": h["hr"], "hiv_lci": h["lci"], "hiv_uci": h["uci"]})
    if view in ("models", "overview") and SERVE.has_table("ml_eval_metrics"):
        mets = SERVE.rows("SELECT model_id, tier, auroc, auprc, median_lead_time_days FROM ml_eval_metrics WHERE split = 'test'")
        facts["models"] = mets
    return facts


def template_cards(view: str, f: dict) -> list[dict]:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    cards = []

    def add(cid, title, body, severity, evidence):
        cards.append({"id": cid, "title": title, "body": body, "severity": severity, "evidence": evidence,
                      "generated_by": "template", "generated_at": now})

    if f.get("young_apc") is not None and view in ("overview", "trends"):
        sig = "rising" if f.get("young_significant") and f["young_apc"] > 0 else "changing"
        add("trend-young-onset", f"Young-onset cases {sig}",
            f"Among people under 50, the age-adjusted rate has changed about {_f(f['young_apc'])}% per year since {f['young_jp_year']} "
            f"(95% CI {_f(f['young_apc_lci'])} to {_f(f['young_apc_uci'])}%)"
            + (f", while rates in people 65+ changed {_f(f['old_apc'])}% per year." if f.get('old_apc') is not None else "."),
            "warning" if f["young_apc"] > 0 else "info",
            [{"metric": "mart_joinpoint.apc", "series_id": "NATIONAL|ALL|<50|CONFIRMED_PROBABLE", "value": f["young_apc"]}])
    if f.get("hotspots") and view in ("overview", "geo"):
        names = ", ".join(h["name"] for h in f["hotspots"][:3])
        add("geo-hotspots", "Highland hotspot cluster",
            f"{names} form a statistically significant High-High cluster (local Moran's I). The highest pooled rate is "
            f"{_f(f['hotspots'][0]['asr'])} per 100,000 (SIR {_f(f['hotspots'][0]['sir'], 2)}).", "warning",
            [{"metric": "mart_spatial.lisa_quadrant", "value": "HH"}])
    if f.get("crude_top") and view in ("geo",):
        tops = {x["name"] for x in f.get("top_districts", [])}
        decoys = [x for x in f["crude_top"] if x["name"] not in tops]
        if decoys:
            d = decoys[0]
            add("geo-crude-vs-asr", f"{d['name']}: older population, not higher risk",
                f"{d['name']} ranks in the top 3 by crude rate ({_f(d['crude_rate'])} per 100,000) but its age-standardised rate is "
                f"{_f(d['asr'])} - the difference is the age structure.", "info", [{"metric": "mart_rates.crude_rate", "value": d["crude_rate"]}])
    if f.get("national_asr") is not None and view in ("overview",):
        add("kpi-asr", f"National rate {f['kpi_year']}",
            f"{f['cases']} cases in {f['kpi_year']}; age-standardised rate {_f(f['national_asr'])} per 100,000 "
            f"(95% CI {_f(f['asr_lci'])}-{_f(f['asr_uci'])}). {_f(f['pct_stage_iv'], 0)}% of staged cases were stage IV.",
            "info", [{"metric": "mart_kpis.national_asr", "value": f["national_asr"]}])
    if f.get("pct_ge3_gi_cases") is not None and view in ("overview", "warning"):
        add("warning-visits", "Warning signs were seen, then missed",
            f"{_f(f['pct_ge3_gi_cases'], 0)}% of patients had 3 or more stomach-complaint visits in the 2 years before diagnosis, versus "
            f"{_f(f['pct_ge3_gi_controls'], 0)}% of matched controls.", "warning",
            [{"metric": "mart_warning_summary.pct_ge3_gi_visits_24m", "value": f["pct_ge3_gi_cases"]}])
    if f.get("interval_malaria_months") is not None and view in ("warning",):
        diff = f["interval_malaria_months"] - f["interval_other_months"]
        add("warning-malaria", "Anaemia read as malaria",
            f"In malaria-endemic provinces the median diagnostic interval is {_f(f['interval_malaria_months'])} months versus "
            f"{_f(f['interval_other_months'])} elsewhere - about {_f(diff)} months longer.", "warning",
            [{"metric": "mart_diag_interval.median_days", "value": f["interval_malaria_months"]}])
    if f.get("stage4_low") is not None and view in ("quality", "overview"):
        add("quality-tier", "Testing for H. pylori goes with earlier diagnosis",
            f"Patients first seen at low-testing facilities were stage IV in {_f(f['stage4_low'], 0)}% of cases versus "
            f"{_f(f['stage4_high'], 0)}% at high-testing facilities"
            + (f"; 1-year survival {_f(f['surv1_low'], 0)}% vs {_f(f['surv1_high'], 0)}%." if f.get("surv1_low") is not None else "."),
            "warning", [{"metric": "mart_stage_mix.pct_known", "value": f["stage4_low"]}])
    if f.get("hiv_hr") is not None and view in ("quality",):
        ok = f["hiv_lci"] is not None and f["hiv_uci"] is not None and f["hiv_lci"] <= 1 <= f["hiv_uci"]
        if ok:
            add("quality-negative-control", "What doesn't matter: HIV",
                f"HIV status is not associated with gastric cancer (HR {_f(f['hiv_hr'], 2)}, 95% CI {_f(f['hiv_lci'], 2)}-{_f(f['hiv_uci'], 2)}) - "
                "the negative control behaves as expected.", "info", [{"metric": "mart_cox.hr", "value": f["hiv_hr"]}])
        else:
            add("quality-negative-control", "Negative control check failed",
                f"HIV, which should have no effect, shows HR {_f(f['hiv_hr'], 2)} (95% CI {_f(f['hiv_lci'], 2)}-{_f(f['hiv_uci'], 2)}). "
                "Treat the cohort estimates on this page with caution: residual bias is likely.", "warning",
                [{"metric": "mart_cox.hr", "value": f["hiv_hr"]}])
    if f.get("erad_hr") is not None and view in ("quality",):
        add("quality-eradication", "Eradication associated with lower risk",
            f"Among H. pylori positive patients, eradication therapy is associated with a hazard ratio of {_f(f['erad_hr'], 2)} "
            f"(95% CI {_f(f['erad_lci'], 2)}-{_f(f['erad_uci'], 2)}) for later gastric cancer.", "info",
            [{"metric": "mart_cox.hr", "value": f["erad_hr"]}])
    if f.get("models") and view in ("models",):
        best = max(f["models"], key=lambda x: x["auroc"] or 0)
        add("models-best", "Models beat the points score",
            f"Best test AUROC {_f(best['auroc'], 3)} ({best['model_id']}); median lead time "
            f"{_f((best.get('median_lead_time_days') or 0) / 30.44)} months before diagnosis.", "info",
            [{"metric": "ml_eval_metrics.auroc", "value": best["auroc"]}])
    return cards


def insights(view: str) -> list[dict]:
    f = fact_sheet(view)
    h = hashlib.sha1(json.dumps(f, sort_keys=True, default=str).encode()).hexdigest()
    cached = app_state.cached_insights(view, h)
    if cached is not None:
        return cached
    cards = template_cards(view, f)
    provider = get_provider()
    if provider.name != "template":
        allowed = _numbers(f)
        for c in cards:
            try:
                text = provider.complete(
                    "Rewrite this public-health insight in plain English, <= 70 words, keep every number exactly, no causal claims "
                    "beyond 'associated with'. Return only the text.", [{"role": "user", "content": c["body"]}],
                    max_tokens=200, purpose="text", timeout=20.0)
                if numbers_supported(text, allowed):
                    c.update({"body": text.strip(), "generated_by": "llm"})
            except LLMUnavailable:
                break
    app_state.store_insights(view, h, cards)
    return cards


def _numbers(obj) -> list[float]:
    out = []
    if isinstance(obj, dict):
        for v in obj.values():
            out += _numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            out += _numbers(v)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append(float(obj))
    return out


def explain_patient(case: dict) -> dict:
    """<= 120 words, template first; optional LLM rephrase from a de-identified fact list."""
    h = case["header"]
    facts = []
    sex = {"M": "man", "F": "woman"}.get(h.get("sex"), "patient")
    facts.append(f"{h.get('age')}-year-old {sex} from {h.get('district_name') or h.get('district_code')}.")
    sym = [c for c in case["conditions"] if c["category"] in ("symptom", "diagnosis") and c["months_since_last"] is not None
           and c["months_since_last"] <= 24]
    gi = [c for c in sym if "stomach" in c["organ_ids"] or "oesophagus" in c["organ_ids"]]
    if gi:
        facts.append("In the last 24 months: " + ", ".join(f"{c['label'].lower()} ({c['count']}x)" for c in gi[:4]) + ".")
    hb = next((v for v in case["labs"] if v["concept_id"] == 3100), None)
    if hb and hb.get("series"):
        s = hb["series"]
        facts.append(f"Haemoglobin {s[0]['value']:.1f} -> {s[-1]['value']:.1f} g/dL over {len(s)} measurements.")
    wt = next((v for v in case["vitals"] if v["concept_id"] == 3000), None)
    if wt and wt.get("change_pct_12m") is not None and abs(wt["change_pct_12m"]) >= 3:
        facts.append(f"Weight changed {wt['change_pct_12m']:+.1f}% in 12 months.")
    meds = case.get("medications", {})
    if meds.get("ppi_courses_24m"):
        facts.append(f"{meds['ppi_courses_24m']} acid-suppressant course(s) in 24 months"
                     + (" without an endoscopy." if not case.get("endoscopies") else "."))
    if case.get("tumour"):
        t = case["tumour"]
        facts.append(f"Diagnosed {t.get('case_status', '').lower()} gastric cancer on {t.get('dx_date')}, stage {t.get('stage_group')}"
                     + (f", lesion at the {t['lesion_location']}" if t.get("lesion_location") else "") + ".")
    elif case.get("risk"):
        r = case["risk"]
        facts.append(f"Risk band {r['risk_band']} (12-month probability {100 * (r['ensemble_prob'] or 0):.1f}%, points score {r['t1_score']}).")
        if r.get("top_reasons"):
            facts.append("Main reasons: " + "; ".join(x["label"] for x in r["top_reasons"][:3]) + ".")
    actions = sorted({a["suggested_action"] for a in case.get("alerts", []) if a.get("status") in ("NEW", "ACKNOWLEDGED")})
    if actions:
        facts.append("Suggested: " + "; ".join(actions) + ".")
    text = " ".join(facts)
    out = {"summary": text, "disclaimer": DISCLAIMER, "generated_by": "template"}
    provider = get_provider()
    if provider.name != "template":
        payload = deidentify({"facts": facts})
        try:
            t = provider.complete("Summarise for a clinician in <= 120 words using only these facts. Plain English, no diagnosis.",
                                  [{"role": "user", "content": json.dumps(payload)}], max_tokens=300, purpose="text", timeout=20.0)
            if numbers_supported(t, [float(x) for x in __import__("re").findall(r"-?\d+(?:\.\d+)?", text)]):
                out.update({"summary": t.strip(), "generated_by": provider.name})
        except LLMUnavailable:
            pass
    return out
