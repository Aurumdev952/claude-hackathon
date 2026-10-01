"""Claude-in-the-loop validation of HIGH-risk flags (used by the /validate-risk skill, run under /loop).

    PYTHONPATH=. uv run python scripts/risk_validation.py cases --limit 5      # newest unvalidated HIGH cases + fact bundles
    PYTHONPATH=. uv run python scripts/risk_validation.py append verdicts.json  # validate, enrich, de-dupe, append to the JSONL
    PYTHONPATH=. uv run python scripts/risk_validation.py summary [--json]      # agree/disagree/uncertain, disputed reasons

Reads the published serve DuckDB read-only (data/analytics/current.json, same as api/deps.py), so a loop never stalls
on a stopped API server. Output: reports/risk_validation.jsonl, one object per (patient display_id, risk model).
Patients are identified by display_id only; names are never read.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import uuid
from collections import defaultdict
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]  # works without PYTHONPATH=.

import report_data as RD  # noqa: E402

ALARM_SYMPTOMS = {2203, 2205, 2213}             # dysphagia, weight loss, abdominal mass (pt_timeline.is_abnormal)
GI_BLEED_DX = {2016, 2017, 2018}                 # haematemesis / melaena / GI bleed diagnoses (ml/features.py)
HP_LABS = {3120: "stool antigen", 3121: "serology", 3122: "breath test", 5006: "rapid urease", 5024: "histology"}
OTHER_LABS = {3101: "MCV", 3102: "Ferritin", 3107: "Albumin", 3104: "Platelets"}
ORDERS = {8000: "endoscopy", 8005: "abdominal ultrasound", 8006: "CT abdomen", 8003: "referral hospital", 8004: "oncology"}
DRUG_CLASSES = ("PPI_COURSE", "PPI_SHORT", "HP_ERADICATION", "IRON_THERAPY", "ANTIMALARIAL", "ANTHELMINTHIC", "ANTACID")
FEATURE_DROP = {"patient_id", "L", "as_of", "province_code"}
REQUIRED = ("patient_id", "verdict", "confidence", "evidence")


def _die(msg: str, code: int = 2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def _need_db():
    con, cur = RD.connect()
    if con is None:
        _die("no published analytics (data/analytics/current.json missing). Build the dev dataset first: make dev-data", 3)
    if not RD.has_table(con, "pt_risk"):
        _die("pt_risk is not published yet: run `make train` (scores and publishes pt_risk/pt_alerts)", 3)
    return con, cur


# ---------------------------------------------------------------------------------------------- cases
def _date(ts: str | None) -> str | None:
    return ts[:10] if ts else None


def _days_before(ts: str, asof: dt.datetime) -> int:
    return (asof - dt.datetime.fromisoformat(ts)).days


def _r(v):
    v = RD.clean(v)
    return round(v, 2) if isinstance(v, float) else v


def fact_bundle(con, pid: int, asof: dt.datetime) -> dict:
    ev = RD.rows(con, """SELECT ts, event_type, concept_id, label, value_num, value_text, unit, is_abnormal
                         FROM pt_timeline WHERE patient_id = ? AND ts <= CAST(? AS TIMESTAMP) ORDER BY ts""",
                 [pid, asof.isoformat()])
    w24 = (asof - dt.timedelta(days=730)).isoformat()
    w12 = (asof - dt.timedelta(days=365)).isoformat()

    def series(etype, cid, n=8):
        s = [e for e in ev if e["event_type"] == etype and e["concept_id"] == cid and e["value_num"] is not None and e["ts"] >= w24]
        return [{"date": _date(e["ts"]), "value": round(e["value_num"], 1), "low": bool(e["is_abnormal"])} for e in s[-n:]]

    sx: dict[str, dict] = {}
    for e in ev:
        if e["event_type"] == "SYMPTOM" and e["ts"] >= w24:
            s = sx.setdefault(e["label"], {"symptom": e["label"], "alarm": e["concept_id"] in ALARM_SYMPTOMS, "n_24m": 0, "n_12m": 0,
                                           "first": _date(e["ts"])})
            s["n_24m"] += 1
            s["n_12m"] += e["ts"] >= w12
            s["last"] = _date(e["ts"])
    dx: dict[str, dict] = {}
    for e in ev:
        if e["event_type"] == "DIAGNOSIS" and e["ts"] >= w24:
            d = dx.setdefault(e["label"], {"diagnosis": e["label"], "n_24m": 0, "certainty": e["value_text"],
                                           "gi_bleed": e["concept_id"] in GI_BLEED_DX})
            d["n_24m"] += 1
            d["n_12m"] = d.get("n_12m", 0) + (e["ts"] >= w12)
            d["last"] = _date(e["ts"])
    hp = [{"date": _date(e["ts"]), "test": HP_LABS[e["concept_id"]], "result": e["value_text"]}
          for e in ev if e["event_type"] == "LAB" and e["concept_id"] in HP_LABS]
    drugs = defaultdict(list)
    for e in ev:
        if e["event_type"] == "DRUG" and e["value_text"] in DRUG_CLASSES:
            drugs[e["value_text"]].append(e["ts"])
    ppi = sorted(drugs["PPI_COURSE"] + drugs["PPI_SHORT"])
    endo = [{"date": _date(e["ts"]), "days_before": _days_before(e["ts"], asof), "impression": e["label"],
             "lesion_location": e["value_text"], "abnormal": bool(e["is_abnormal"])} for e in ev if e["event_type"] == "ENDOSCOPY"]
    path = [{"date": _date(e["ts"]), "histology": e["label"]} for e in ev if e["event_type"] == "PATHOLOGY"]
    orders = [{"date": _date(e["ts"]), "days_before": _days_before(e["ts"], asof), "order": ORDERS[e["concept_id"]],
               "status": e["value_text"]} for e in ev if e["event_type"] == "ORDER" and e["concept_id"] in ORDERS]
    other = {}
    for cid, name in OTHER_LABS.items():
        s = [e for e in ev if e["event_type"] == "LAB" and e["concept_id"] == cid and e["value_num"] is not None]
        if s:
            other[name] = {"value": round(s[-1]["value_num"], 1), "unit": s[-1]["unit"], "date": _date(s[-1]["ts"]),
                           "abnormal": bool(s[-1]["is_abnormal"])}
    visits = [e for e in ev if e["event_type"] == "VISIT"]
    return {
        "haemoglobin_g_dl": series("LAB", 3100),
        "weight_kg": series("VITAL", 3000),
        "symptoms_24m": sorted(sx.values(), key=lambda s: (not s["alarm"], -s["n_24m"])),
        # same definition as ml/features.py n_alarm_features_12m: dysphagia, weight loss, mass, GI bleeding, vomiting >= 2
        "alarm_features_12m": sorted([s["symptom"] for s in sx.values() if s["alarm"] and s["n_12m"]]
                                     + [d["diagnosis"] for d in dx.values() if d["gi_bleed"] and d.get("n_12m")]
                                     + [s["symptom"] for s in sx.values() if s["symptom"] == "Nausea and vomiting" and s["n_12m"] >= 2]),
        "diagnoses_24m": sorted(dx.values(), key=lambda d: -d["n_24m"])[:10],
        "h_pylori": {"tests": hp[-6:], "ever_positive": any(t["result"] == "Positive" for t in hp),
                     "eradication_courses": [_date(t) for t in drugs["HP_ERADICATION"]]},
        "acid_suppression": {"ppi_courses_12m": sum(t >= w12 for t in ppi), "ppi_courses_24m": sum(t >= w24 for t in ppi),
                             "last_ppi": _date(ppi[-1]) if ppi else None,
                             "antacid_rx_12m": sum(t >= w12 for t in drugs["ANTACID"])},
        "other_courses_12m": {k.lower(): sum(t >= w12 for t in drugs[k]) for k in ("IRON_THERAPY", "ANTIMALARIAL", "ANTHELMINTHIC")},
        "endoscopy": {"procedures": endo, "pathology": path, "never_scoped": not endo,
                      "orders": [o for o in orders if o["order"] == "endoscopy"],
                      "other_workup_orders": [o for o in orders if o["order"] != "endoscopy"][-5:]},
        "other_labs_latest": other,
        "visits": {"n_12m": sum(e["ts"] >= w12 for e in visits), "n_24m": sum(e["ts"] >= w24 for e in visits),
                   "last": _date(visits[-1]["ts"]) if visits else None},
    }


def _features(con, pid: int) -> dict:
    f = RD.one(con, "SELECT * FROM pt_features WHERE patient_id = ?", [pid]) if RD.has_table(con, "pt_features") else None
    if not f:
        return {}
    out = {}
    for k, v in f.items():
        if k in FEATURE_DROP or v is None:
            continue
        out[k] = round(v, 3) if isinstance(v, float) else v
    return out


def _open_alerts(con, pid: int) -> list[dict]:
    if not RD.has_table(con, "pt_alerts"):
        return []
    al = RD.rows(con, """SELECT alert_id, "trigger", severity, status, summary, CAST(created_at AS DATE) AS created
                         FROM pt_alerts WHERE patient_id = ? ORDER BY created_at DESC""", [pid])
    st = RD.alert_status_overlay([a["alert_id"] for a in al])
    out = []
    for a in al:
        status = st.get(a["alert_id"], a["status"])
        if status in ("NEW", "ACKNOWLEDGED"):
            out.append({"trigger": a["trigger"], "severity": a["severity"], "status": status, "created": a["created"],
                        "summary": a["summary"]})
    return out


def candidates(con, cur, limit: int, band: str = "HIGH", include_validated: bool = False) -> dict:
    model_id = RD.risk_model_id(con)
    done = set() if include_validated else RD.validated_keys()
    allc = RD.rows(con, """
        SELECT r.patient_id AS _pid, p.display_id AS patient_id, p.sex, p.age, p.district_code, d.name AS district,
               l.name AS facility, r.facility_id, l.facility_type, r.risk_band, r.ensemble_prob, r.t1_score, r.t1_band, r.t2_prob,
               r.t3_prob, r.rank_in_facility, r.scoped_since_flag, r.first_high_at, r.as_of, r.top_reasons
        FROM pt_risk r JOIN pt_patient p USING (patient_id)
        LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
        LEFT JOIN ref_district d ON d.district_code = p.district_code
        WHERE r.risk_band = ? AND NOT p.is_case
        ORDER BY r.first_high_at DESC NULLS LAST, r.ensemble_prob DESC, r.t1_score DESC, p.display_id""", [band])
    pending = [c for c in allc if RD.record_key(c["patient_id"], model_id) not in done]
    out = []
    for c in pending[:limit]:
        pid = c.pop("_pid")
        asof = dt.datetime.fromisoformat(c["as_of"])
        reasons = RD.parse_json(c.pop("top_reasons")) or []
        c["facility"] = RD.facility_short(c["facility"])
        c["ensemble_prob"] = round(c["ensemble_prob"], 4)
        c["t2_prob"] = round(c["t2_prob"], 4) if c["t2_prob"] is not None else None
        c["t3_prob"] = round(c["t3_prob"], 4) if c["t3_prob"] is not None else None
        c["as_of"] = c["as_of"][:10]
        c["top_reasons"] = [{"feature": r.get("feature"), "label": r.get("label"), "value": _r(r.get("value")),
                             "contribution": round(r["contribution"], 3) if r.get("contribution") is not None else None}
                            for r in reasons]
        c["facts"] = fact_bundle(con, pid, asof)
        c["features"] = _features(con, pid)
        c["open_alerts"] = _open_alerts(con, pid)
        out.append(c)
    thr = RD.one(con, "SELECT high_cut, medium_cut FROM ml_thresholds") if RD.has_table(con, "ml_thresholds") else None
    return {"run_id": cur.get("run_id"), "sim_time": cur.get("sim_time"), "model_id": model_id, "thresholds": thr,
            "band": band, "pending_total": len(pending), "already_validated": len(allc) - len(pending), "returned": len(out),
            "cases": out}


# ---------------------------------------------------------------------------------------------- append
def _load_verdicts(path: str) -> tuple[list[dict], dict]:
    raw = json.load(sys.stdin if path == "-" else open(path))
    if isinstance(raw, list):
        return raw, {}
    if isinstance(raw, dict) and isinstance(raw.get("verdicts"), list):
        return raw["verdicts"], {k: v for k, v in raw.items() if k != "verdicts"}
    if isinstance(raw, dict) and "patient_id" in raw:
        return [raw], {}
    _die("verdicts file must be a list of verdict objects or {\"validator\": ..., \"verdicts\": [...]}")


def _validate(v: dict, i: int) -> list[str]:
    errs = []
    for k in REQUIRED:
        if k not in v or v[k] in (None, ""):
            errs.append(f"verdicts[{i}]: missing '{k}'")
    if v.get("verdict") not in RD.VERDICTS:
        errs.append(f"verdicts[{i}]: verdict must be one of {RD.VERDICTS}")
    c = v.get("confidence")
    if not isinstance(c, (int, float)) or not 0 <= c <= 1:
        errs.append(f"verdicts[{i}]: confidence must be a number in [0, 1]")
    ev = v.get("evidence")
    if not isinstance(ev, list) or not ev or not all(isinstance(x, str) and x.strip() for x in ev):
        errs.append(f"verdicts[{i}]: evidence must be a non-empty list of strings")
    for j, rc in enumerate(v.get("reason_checks") or []):
        if not isinstance(rc, dict) or "feature" not in rc or rc.get("supported") not in (True, False, None):
            errs.append(f"verdicts[{i}].reason_checks[{j}]: needs feature and supported true|false|null")
    for bad in ("name", "given_name", "family_name", "patient_name"):
        if bad in v:
            errs.append(f"verdicts[{i}]: '{bad}' is not allowed (display_id only)")
    return errs


def append(path: str, dry_run: bool = False) -> dict:
    verdicts, header = _load_verdicts(path)
    errs = [e for i, v in enumerate(verdicts) for e in _validate(v, i)]
    if errs:
        _die("schema validation failed, nothing appended:\n  " + "\n  ".join(errs))
    con, cur = RD.connect()
    model_id = RD.risk_model_id(con) if con is not None else header.get("model_id")
    ids = [v["patient_id"] for v in verdicts]
    ctx = {}
    if con is not None and RD.has_table(con, "pt_risk"):
        q = f"""SELECT p.display_id AS patient_id, l.name AS facility, r.facility_id, p.district_code, r.risk_band, r.ensemble_prob,
                       r.t1_score, r.top_reasons, CAST(r.as_of AS DATE) AS as_of
                FROM pt_risk r JOIN pt_patient p USING (patient_id) LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
                WHERE p.display_id IN ({','.join('?' * len(ids))})"""
        ctx = {r["patient_id"]: r for r in RD.rows(con, q, ids)} if ids else {}
    existing = RD.validated_keys()
    run_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run_id = header.get("run_id") or f"val-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:6]}"
    out, refused, unknown = [], [], []
    for v in verdicts:
        pid = v["patient_id"]
        key = RD.record_key(pid, model_id)
        if key in existing:
            refused.append(pid)
            continue
        c = ctx.get(pid)
        if con is not None and c is None:
            unknown.append(pid)
            continue
        c = c or v
        reasons = RD.parse_json(c.get("top_reasons")) or []
        rec = {"run_at": run_at, "run_id": run_id, "pipeline_run_id": cur.get("run_id") if cur else v.get("pipeline_run_id"),
               "as_of": str(c.get("as_of"))[:10] if c.get("as_of") else None, "model_id": model_id,
               "validator": v.get("validator") or header.get("validator"),
               "patient_id": pid, "facility": RD.facility_short(c.get("facility")), "facility_id": c.get("facility_id"),
               "district_code": c.get("district_code"), "risk_band": c.get("risk_band"),
               "ensemble_prob": round(c["ensemble_prob"], 4) if c.get("ensemble_prob") is not None else None,
               "t1_score": c.get("t1_score"),
               "top_reasons": [{"feature": r.get("feature"), "label": r.get("label")} if isinstance(r, dict) else r for r in reasons],
               "verdict": v["verdict"], "confidence": round(float(v["confidence"]), 2),
               "evidence": [x.strip() for x in v["evidence"]], "reason_checks": v.get("reason_checks") or [],
               "suggested_action": v.get("suggested_action"), "notes": v.get("notes") or ""}
        existing.add(key)
        out.append(rec)
    if con is not None:
        con.close()
    if unknown:
        _die(f"not HIGH/scored in the published run (check the display ids): {', '.join(unknown)}; nothing appended")
    if out and not dry_run:
        RD.JSONL.parent.mkdir(parents=True, exist_ok=True)
        with open(RD.JSONL, "a") as f:
            for r in out:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    snap = RD.refresh_snapshot() if out and not dry_run else None
    return {"appended": len(out), "refused_duplicates": refused, "run_id": run_id, "jsonl": str(RD.JSONL.relative_to(RD.ROOT)),
            "snapshot": str(snap.relative_to(RD.ROOT)) if snap else None, "dry_run": dry_run}


# ---------------------------------------------------------------------------------------------- summary
def summary_text(s: dict) -> str:
    if not s["n"]:
        return "No validations yet (reports/risk_validation.jsonl is empty)."
    lines = [f"Validated cases: {s['n']}  (agree {s['agree']}, disagree {s['disagree']}, uncertain {s['uncertain']})",
             f"Agreement: {s['agreement_pct']}% of all, {s['agreement_pct_decided']}% of decided" if s["agreement_pct_decided"] is not None
             else f"Agreement: {s['agreement_pct']}% of all",
             f"Mean confidence: {s['mean_confidence']}", f"Last run: {s['last_run_at']}"]
    if s["most_disputed"]:
        lines.append("Most disputed reasons: " + ", ".join(f"{d['feature']} ({d['times']})" for d in s["most_disputed"]))
    if s["most_supported"]:
        lines.append("Most supported reasons: " + ", ".join(f"{d['feature']} ({d['times']})" for d in s["most_supported"]))
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cases", help="newest unvalidated HIGH-band cases with de-identified fact bundles (JSON)")
    c.add_argument("--limit", type=int, default=5)
    c.add_argument("--band", default="HIGH", choices=["HIGH", "MEDIUM"])
    c.add_argument("--include-validated", action="store_true", help="do not exclude cases already in the JSONL")
    a = sub.add_parser("append", help="append Claude's verdicts (JSON file or - for stdin) to reports/risk_validation.jsonl")
    a.add_argument("verdicts")
    a.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("summary", help="agreement summary of the validation log")
    s.add_argument("--json", action="store_true")
    sub.add_parser("snapshot", help="refresh reports/snapshots/latest.json from the serve DB")
    args = ap.parse_args(argv)
    if args.cmd == "cases":
        con, cur = _need_db()
        try:
            print(json.dumps(candidates(con, cur, max(0, args.limit), args.band, args.include_validated), indent=1, default=str))
        finally:
            con.close()
    elif args.cmd == "append":
        print(json.dumps(append(args.verdicts, args.dry_run), indent=1))
    elif args.cmd == "summary":
        sm = RD.validation_summary()
        print(json.dumps(sm, indent=1) if args.json else summary_text(sm))
    elif args.cmd == "snapshot":
        p = RD.refresh_snapshot()
        if p is None:
            _die("no published analytics to snapshot", 3)
        print(p.relative_to(RD.ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
