"""Compare the published results with the reference build (docs/reference_results.json).

Run after `make reproduce` (or bootstrap + train), before the live loop advances the data:
    PYTHONPATH=. uv run python scripts/verify_results.py
Exit code 1 when any check is outside its tolerance.
"""
from __future__ import annotations

import json
import sys

import duckdb

from shared.config import ANALYTICS_DIR, DATA_DIR, ROOT

P = "sex = 'ALL' AND age_band = 'ALL' AND case_def = 'CONFIRMED_PROBABLE'"


def measured(con) -> dict:
    one = lambda sql: con.execute(sql).fetchone()  # noqa: E731
    m = {
        "national_asr_2024": one(f"SELECT asr FROM mart_rates WHERE level = 'NATIONAL' AND period = '2024' AND {P}")[0],
        "incident_cases": one("SELECT count(*) FROM core_gc_case")[0],
        "confirmed_cases": one("SELECT count(*) FROM core_gc_case WHERE case_status = 'CONFIRMED'")[0],
        "gi_cohort": one("SELECT count(*) FROM core_gi_cohort")[0],
        "under50_apc": one("SELECT apc FROM mart_joinpoint WHERE series_id = 'NATIONAL|ALL|<50|CONFIRMED_PROBABLE' "
                           "ORDER BY segment_no DESC LIMIT 1")[0],
        "lisa_hh": sorted(r[0] for r in con.execute("SELECT district_code FROM mart_spatial WHERE lisa_quadrant = 'HH'").fetchall()),
    }
    surv = {(g, v): s for g, v, s in con.execute("SELECT group_var, group_value, surv_1y FROM mart_survival_summary").fetchall()}
    m["surv_1y_all"] = surv.get(("all", "all"))
    m["surv_1y_low_tier"] = surv.get(("facility_tier", "low"))
    m["surv_1y_high_tier"] = surv.get(("facility_tier", "high"))
    cox = {mid: (hr, lci, uci) for mid, hr, lci, uci in con.execute(
        "SELECT model_id, hr, lci, uci FROM mart_cox WHERE term IN ('eradicated', 'hiv')").fetchall()}
    m["eradication_hr"] = cox.get("eradication_ins4")
    m["hiv_negative_control_hr"] = cox.get("hiv_negative_control")
    # latest evaluated model per tier (tier 0 = ensemble)
    au = {t: a for t, a in con.execute("""SELECT tier, arg_max(auroc, model_id) FROM ml_eval_metrics
                                           WHERE split = 'test' GROUP BY tier""").fetchall()}
    m.update(auroc_tier1=au.get(1), auroc_tier2=au.get(2), auroc_tier3=au.get(3), auroc_ensemble=au.get(0))
    return m


def check(key: str, ref: dict, got) -> tuple[bool, str, str]:
    want = ref["value"]
    if got is None:
        return False, "missing", str(want)
    if key == "lisa_hh":
        overlap = len(set(got) & set(want))
        return overlap >= ref["min_overlap"], ", ".join(got) or "none", f"{', '.join(want)} (>= {ref['min_overlap']} shared)"
    if key in ("eradication_hr", "hiv_negative_control_hr"):
        hr, lci, uci = got
        ci_ok = uci < 1.0 if key == "eradication_hr" else lci <= 1.0 <= uci
        return abs(hr - want) <= ref["tol"] and ci_ok, f"{hr:.2f} ({lci:.2f}-{uci:.2f})", f"{want} ± {ref['tol']}"
    if "tol_pct" in ref:
        ok = abs(got - want) <= want * ref["tol_pct"] / 100
        return ok, f"{got:,}", f"{want:,} ± {ref['tol_pct']}%"
    return abs(got - want) <= ref["tol"], f"{got:.3f}" if abs(got) < 10 else f"{got:.1f}", f"{want} ± {ref['tol']}"


def main() -> int:
    refs = json.load(open(ROOT / "docs" / "reference_results.json"))
    cur_path = ANALYTICS_DIR / "current.json"
    if not cur_path.exists():
        print("No published results yet: run `make reproduce` (or `make bootstrap && make train`) first.")
        return 1
    cur = json.load(open(cur_path))
    gt_path = DATA_DIR / "ground_truth.json"
    scale = json.load(open(gt_path)).get("scale") if gt_path.exists() else None
    print(f"Published run #{cur['run_id']} (sim time {cur['sim_time']}, scale {scale}) vs reference "
          f"(scale {refs['scale']}, seed {refs['seed']}, history end {refs['history_end']})\n")
    if scale is not None and float(scale) != float(refs["scale"]):
        print(f"!! This dataset was generated at scale {scale}; the reference numbers are for scale {refs['scale']}.\n")
    if cur["sim_time"][:10] > refs["history_end"]:
        print("!! The live loop has advanced past history end, so counts and rates have moved on; "
              "compare right after `make reproduce` for an exact check.\n")
    con = duckdb.connect(str(ANALYTICS_DIR / cur["file"]), read_only=True)
    got = measured(con)
    bad = 0
    width = max(len(r["label"]) for r in refs["checks"].values())
    for key, ref in refs["checks"].items():
        ok, g, w = check(key, ref, got.get(key))
        bad += not ok
        print(f"  {'✓' if ok else '✗'}  {ref['label']:<{width}}  {g:<34} reference {w}")
    print(f"\n{len(refs['checks']) - bad}/{len(refs['checks'])} checks within tolerance")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
