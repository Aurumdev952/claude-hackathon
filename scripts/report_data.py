"""Shared data access for the Claude Code automations (scripts/risk_validation.py, scripts/daily_report.py).

Reads the published serve DuckDB read-only (same pattern as api/deps.py: follow data/analytics/current.json), builds the
compact de-identified snapshot that the daily report renders from (reports/snapshots/latest.json) and reads/summarises
the validation log (reports/risk_validation.jsonl).

De-identification rule: patients are referred to by display_id only. Names (pt_patient.given_name/family_name) are never
selected by anything in this module.
"""
from __future__ import annotations

import datetime as dt
import json
import math
from collections import Counter
from pathlib import Path

from shared.config import ANALYTICS_DIR, ROOT

REPORTS_DIR = ROOT / "reports"
JSONL = REPORTS_DIR / "risk_validation.jsonl"
SNAP_DIR = REPORTS_DIR / "snapshots"
SNAP_LATEST = SNAP_DIR / "latest.json"
DAILY_DIR = REPORTS_DIR / "daily"
VERDICTS = ("agree", "disagree", "uncertain")
TRIGGERS = ("RISK_BAND_HIGH", "ALARM_NO_SCOPE_90D", "HB_DROP", "HP_POS_UNTREATED")
TRIGGER_LABEL = {"RISK_BAND_HIGH": "High risk band", "ALARM_NO_SCOPE_90D": "Alarm, no scope 90 d",
                 "HB_DROP": "Haemoglobin drop", "HP_POS_UNTREATED": "H. pylori untreated",
                 "CARE_OVERDUE": "Care task overdue"}  # v3: raised by the care engine's escalation ladder
NEW_ALERT_DAYS = 7  # an alert is "new" when created within this many sim days of the published sim time


# ----------------------------------------------------------------------------------------------- serve DB
def current() -> dict | None:
    try:
        return json.load(open(ANALYTICS_DIR / "current.json"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def connect():
    """Read-only connection to the active serve file, or None when no published analytics exist (fresh session)."""
    cur = current()
    if not cur:
        return None, None
    path = ANALYTICS_DIR / cur.get("file", f"serve_{cur['active']}.duckdb")
    if not path.exists():
        return None, None
    import duckdb

    return duckdb.connect(str(path), read_only=True), cur


def clean(v):
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        try:
            return clean(v.item())
        except Exception:
            return v
    if v is not None and type(v).__name__ == "NAType":
        return None
    return v


def rows(con, sql: str, params: list | None = None) -> list[dict]:
    r = con.execute(sql, params or [])
    cols = [d[0] for d in r.description]
    return [{k: clean(v) for k, v in zip(cols, row)} for row in r.fetchall()]


def one(con, sql: str, params: list | None = None) -> dict | None:
    r = rows(con, sql, params)
    return r[0] if r else None


def has_table(con, name: str) -> bool:
    return bool(con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]).fetchone()[0])


def active_models(con) -> dict[int, str]:
    if not has_table(con, "ml_model_registry"):
        return {}
    return {t: m for t, m in con.execute("SELECT tier, model_id FROM ml_model_registry WHERE is_active").fetchall()}


def risk_model_id(con) -> str | None:
    """The model the risk band comes from: the active Tier 2 model (Tier 3 joins the ensemble when registered)."""
    m = active_models(con)
    return m.get(2) or m.get(3) or m.get(1)


def facility_short(name: str | None) -> str | None:
    return name.replace(" (Synthetic)", "") if name else name


def parse_json(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return v
    return v


def alert_status_overlay(alert_ids: list[str]) -> dict[str, str]:
    """Doctor status changes live in data/analytics/app_state.sqlite (api/app_state.py); read it without creating it."""
    p = ANALYTICS_DIR / "app_state.sqlite"
    if not alert_ids or not p.exists():
        return {}
    import sqlite3

    try:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        q = f"SELECT alert_id, status FROM alert_status WHERE alert_id IN ({','.join('?' * len(alert_ids))})"
        out = dict(c.execute(q, alert_ids).fetchall())
        c.close()
        return out
    except sqlite3.Error:
        return {}


# ----------------------------------------------------------------------------------------------- validation log
def read_jsonl(path: Path = JSONL) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def record_key(patient_id: str, model_id: str | None) -> str:
    """One validation per patient per risk model: a new registered model re-opens every case."""
    return f"{patient_id}|{model_id or '-'}"


def validated_keys(records: list[dict] | None = None) -> set[str]:
    return {record_key(r.get("patient_id"), r.get("model_id")) for r in (records if records is not None else read_jsonl())}


def latest_verdicts(records: list[dict] | None = None) -> dict[str, dict]:
    """display_id -> most recent validation record."""
    out: dict[str, dict] = {}
    for r in records if records is not None else read_jsonl():
        pid = r.get("patient_id")
        if pid and (pid not in out or (r.get("run_at") or "") >= (out[pid].get("run_at") or "")):
            out[pid] = r
    return out


def validation_summary(records: list[dict] | None = None, top_n: int = 5) -> dict:
    recs = records if records is not None else read_jsonl()
    counts = Counter(r.get("verdict") for r in recs)
    conf = [float(r["confidence"]) for r in recs if isinstance(r.get("confidence"), (int, float))]
    disputed: Counter = Counter()
    supported: Counter = Counter()
    for r in recs:
        checks = r.get("reason_checks") or []
        if checks:
            for c in checks:
                if c.get("supported") is False:
                    disputed[c.get("feature")] += 1
                elif c.get("supported") is True:
                    supported[c.get("feature")] += 1
        elif r.get("verdict") == "disagree":  # older records without per-reason checks: blame the shown reasons
            for t in r.get("top_reasons") or []:
                disputed[t.get("feature") if isinstance(t, dict) else t] += 1
    n = len(recs)
    judged = counts.get("agree", 0) + counts.get("disagree", 0)
    by_model = Counter(r.get("model_id") for r in recs)
    return {"n": n, "agree": counts.get("agree", 0), "disagree": counts.get("disagree", 0),
            "uncertain": counts.get("uncertain", 0),
            "agreement_pct": round(100 * counts.get("agree", 0) / n, 1) if n else None,
            "agreement_pct_decided": round(100 * counts.get("agree", 0) / judged, 1) if judged else None,
            "mean_confidence": round(sum(conf) / len(conf), 3) if conf else None,
            "most_disputed": [{"feature": f, "times": k} for f, k in disputed.most_common(top_n) if f],
            "most_supported": [{"feature": f, "times": k} for f, k in supported.most_common(top_n) if f],
            "last_run_at": max((r.get("run_at") or "" for r in recs), default=None) or None,
            "by_model": dict(by_model)}


# ----------------------------------------------------------------------------------------------- snapshot
def build_snapshot(con, cur: dict, top_n: int = 10) -> dict:
    """Compact, de-identified aggregate of the published run: everything the daily report draws, nothing more."""
    sim_time = dt.datetime.fromisoformat(cur["sim_time"])
    snap: dict = {"schema": 1, "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "run_id": cur.get("run_id"), "sim_time": cur.get("sim_time"), "published_at": cur.get("published_at"),
                  "models": {str(k): v for k, v in active_models(con).items()}, "risk_model_id": risk_model_id(con)}
    thr = one(con, "SELECT high_cut, medium_cut FROM ml_thresholds") if has_table(con, "ml_thresholds") else None
    snap["thresholds"] = thr
    has_risk = has_table(con, "pt_risk")
    # ---- risk bands
    bands = {r["risk_band"]: r["n"] for r in rows(con, "SELECT risk_band, count(*) AS n FROM pt_risk GROUP BY 1")} if has_risk else {}
    snap["bands"] = {"HIGH": bands.get("HIGH", 0), "MEDIUM": bands.get("MEDIUM", 0), "LOW": bands.get("LOW", 0)}
    awaiting = one(con, """SELECT count(*) AS n FROM pt_risk r JOIN pt_patient p USING (patient_id)
                           WHERE r.risk_band = 'HIGH' AND NOT p.is_case AND NOT coalesce(r.scoped_since_flag, FALSE)""")["n"] \
        if has_risk else None
    new_high = one(con, """SELECT count(*) AS n FROM pt_risk WHERE risk_band = 'HIGH'
                           AND first_high_at > CAST(? AS TIMESTAMP) - INTERVAL 7 DAY""", [cur["sim_time"]])["n"] if has_risk else None
    # ---- HIGH count history (one point per scoring date)
    hist = rows(con, """SELECT CAST(as_of AS DATE) AS date, count(*) FILTER (WHERE risk_band = 'HIGH') AS high,
                               count(*) AS scored FROM ml_risk_history GROUP BY 1 ORDER BY 1""") \
        if has_table(con, "ml_risk_history") else []
    snap["high_history"] = hist[-90:]
    # ---- national epidemiology (mart_kpis)
    kp = rows(con, "SELECT * FROM mart_kpis ORDER BY year") if has_table(con, "mart_kpis") else []
    snap["cases_by_year"] = [{"year": k["year"], "cases": k["cases"], "cases_annualised": round(k["cases_annualised"], 1)
                              if k.get("cases_annualised") is not None else None, "asr": k.get("national_asr"),
                              "partial": bool(k.get("partial_year"))} for k in kp]
    last = kp[-1] if kp else {}
    full = [k for k in kp if not k.get("partial_year")]
    snap["kpis"] = {"high_patients": snap["bands"]["HIGH"], "high_awaiting_endoscopy": awaiting, "new_high_patients_7d": new_high,
                    "national_asr": last.get("national_asr"), "national_asr_lci": last.get("national_asr_lci"),
                    "national_asr_uci": last.get("national_asr_uci"), "asr_year": last.get("year"),
                    "asr_partial_year": bool(last.get("partial_year")), "asr_delta": last.get("asr_delta"),
                    "last_full_year": full[-1]["year"] if full else None,
                    "last_full_year_asr": full[-1].get("national_asr") if full else None,
                    "cases_annualised": last.get("cases_annualised")}
    # ---- alerts by trigger (status overlay from app_state)
    alerts = rows(con, """SELECT alert_id, "trigger", severity, status, created_at FROM pt_alerts""") \
        if has_table(con, "pt_alerts") else []
    st = alert_status_overlay([a["alert_id"] for a in alerts])
    cutoff = (sim_time - dt.timedelta(days=NEW_ALERT_DAYS)).isoformat()
    by_trig = {t: {"trigger": t, "label": TRIGGER_LABEL[t], "new": 0, "earlier": 0, "open": 0, "total": 0} for t in TRIGGERS}
    new_high_alerts = 0
    for a in alerts:
        t = a["trigger"]
        b = by_trig.setdefault(t, {"trigger": t, "label": TRIGGER_LABEL.get(t, t.replace("_", " ").title()), "new": 0, "earlier": 0,
                                   "open": 0, "total": 0})
        status = st.get(a["alert_id"], a["status"])
        b["total"] += 1
        if status not in ("NEW", "ACKNOWLEDGED"):
            continue
        b["open"] += 1
        if (a["created_at"] or "") > cutoff:
            b["new"] += 1
            new_high_alerts += a["severity"] == "HIGH"
        else:
            b["earlier"] += 1
    snap["alerts_by_trigger"] = list(by_trig.values())
    snap["kpis"]["new_high_alerts"] = new_high_alerts
    snap["kpis"]["open_alerts"] = sum(b["open"] for b in by_trig.values())
    # ---- top HIGH-risk cases (newest first, then probability)
    snap["top_cases"] = top_cases(con, top_n) if has_risk else []
    # ---- data quality
    snap["data_quality"] = data_quality(con)
    # ---- v3: care coordination and the 2031 outlook (absent tables -> None, the page shows a placeholder)
    snap["schema"] = 2
    snap["care"] = care_summary(con, sim_time)
    snap["forecast"] = forecast_summary(con)
    return snap


CARE_OPEN = ("SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED")
CARE_LATE = ("OVERDUE", "ESCALATED")


def care_summary(con, sim_time: dt.datetime, days: int = NEW_ALERT_DAYS) -> dict | None:
    """Care coordination KPIs from the published care snapshot (pt_care_plan / pt_care_task): plans approved in the last
    `days` sim days, open and overdue tasks, the task completion rate (completed / tasks that are completed or past due,
    cancelled excluded) and the median days from plan approval to a completed endoscopy. Counts only, no patient ids."""
    plan_t = "pt_care_plan" if has_table(con, "pt_care_plan") else "care_plans" if has_table(con, "care_plans") else None
    task_t = "pt_care_task" if has_table(con, "pt_care_task") else "care_tasks" if has_table(con, "care_tasks") else None
    if not plan_t or not task_t:
        return None
    st = sim_time.isoformat()
    p = one(con, f"""SELECT count(*) AS plans_total, count(*) FILTER (WHERE status IN ('ACTIVE', 'ESCALATED')) AS plans_active,
                             count(*) FILTER (WHERE approved_at > CAST(? AS TIMESTAMP) - INTERVAL {int(days)} DAY) AS new_plans_7d,
                             count(DISTINCT facility_id) AS facilities
                      FROM {plan_t}""", [st]) or {}
    ph = ",".join(f"'{x}'" for x in CARE_OPEN)
    late = ",".join(f"'{x}'" for x in CARE_LATE)
    t = one(con, f"""SELECT count(*) FILTER (WHERE status IN ({ph})) AS open_tasks,
                             count(*) FILTER (WHERE status IN ({late})) AS overdue_tasks,
                             count(*) FILTER (WHERE status IN ({late}) AND coalesce(escalation_level, 0) >= 2) AS chw_escalations,
                             count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
                             count(*) FILTER (WHERE status <> 'CANCELLED' AND (status = 'COMPLETED' OR due_at <= CAST(? AS TIMESTAMP))) AS due_or_done
                      FROM {task_t}""", [st]) or {}
    endo = one(con, f"""SELECT count(*) AS n, median(date_diff('day', p.approved_at, t.completed_at)) AS median_days
                         FROM {task_t} t JOIN {plan_t} p ON p.id = t.plan_id
                         WHERE t.type = 'ENDOSCOPY' AND t.status = 'COMPLETED' AND t.completed_at IS NOT NULL""") or {}
    by_pw = rows(con, f"SELECT pathway, count(*) AS plans FROM {plan_t} GROUP BY 1 ORDER BY 2 DESC, 1")
    due = t.get("due_or_done") or 0
    return {"plans_total": p.get("plans_total") or 0, "plans_active": p.get("plans_active") or 0,
            "new_plans_7d": p.get("new_plans_7d") or 0, "facilities": p.get("facilities") or 0,
            "open_tasks": t.get("open_tasks") or 0, "overdue_tasks": t.get("overdue_tasks") or 0,
            "chw_escalations": t.get("chw_escalations") or 0, "completed_tasks": t.get("completed") or 0,
            "due_or_done_tasks": due,
            "completion_rate_pct": round(100 * (t.get("completed") or 0) / due, 1) if due else None,
            "endoscopies_completed": endo.get("n") or 0,
            "median_days_to_endoscopy": round(endo["median_days"], 1) if endo.get("median_days") is not None else None,
            "by_pathway": by_pw, "window_days": days}


def forecast_summary(con) -> dict | None:
    """National incidence outlook from mart_forecast (synthetic registry series): the horizon year's mean with its 80 / 95%
    prediction interval, the last observed year and a short history + forecast series for the sparkline."""
    if not has_table(con, "mart_forecast"):
        return None
    cd = (one(con, "SELECT case_def FROM ml_forecast_runs ORDER BY created_at DESC LIMIT 1") or {}).get("case_def") \
        if has_table(con, "ml_forecast_runs") else None
    sid = f"NATIONAL|ALL|ALL|{cd or 'REGISTRY'}"
    pts = rows(con, """SELECT year(period)::INT AS year, kind, mean, lo80, hi80, lo95, hi95, model, run_id FROM mart_forecast
                       WHERE series_id = ? AND metric = 'cases' AND freq = 'Y' ORDER BY period""", [sid])
    fc = [x for x in pts if x["kind"] == "forecast"]
    hist = [x for x in pts if x["kind"] == "history"]
    if not fc:
        return None
    last, base = fc[-1], (hist[-1] if hist else None)
    r1 = lambda v: round(v, 1) if v is not None else None  # noqa: E731
    return {"series_id": sid, "horizon_year": last["year"], "mean": r1(last["mean"]), "lo80": r1(last["lo80"]),
            "hi80": r1(last["hi80"]), "lo95": r1(last["lo95"]), "hi95": r1(last["hi95"]), "model": last["model"],
            "run_id": last["run_id"], "base_year": base["year"] if base else None, "base_cases": r1(base["mean"]) if base else None,
            "change_pct": round(100 * (last["mean"] - base["mean"]) / base["mean"], 1) if base and base["mean"] else None,
            "series": [{"year": x["year"], "kind": x["kind"], "mean": r1(x["mean"]), "lo80": r1(x["lo80"]), "hi80": r1(x["hi80"]),
                        "lo95": r1(x["lo95"]), "hi95": r1(x["hi95"])} for x in pts if x["year"] >= last["year"] - 16]}


def top_cases(con, n: int = 10) -> list[dict]:
    """HIGH-band, not-yet-diagnosed patients, newest flag first then probability. When fewer than n are HIGH, the list is
    topped up with the highest-probability MEDIUM patients (band field says which), so the report shows who is next."""
    sql = """
        SELECT p.display_id AS patient_id, p.sex, p.age, p.district_code, d.name AS district, l.name AS facility,
               r.facility_id, r.risk_band, r.ensemble_prob, r.t1_score, r.top_reasons,
               CASE WHEN r.first_high_at IS NULL THEN NULL ELSE r.scoped_since_flag END AS scoped,
               r.first_high_at, CAST(r.as_of AS DATE) AS as_of
        FROM pt_risk r JOIN pt_patient p USING (patient_id)
        LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
        LEFT JOIN ref_district d ON d.district_code = p.district_code
        WHERE NOT p.is_case AND r.risk_band = ?
        ORDER BY r.first_high_at DESC NULLS LAST, r.ensemble_prob DESC, r.t1_score DESC, p.display_id LIMIT ?"""
    rs = rows(con, sql, ["HIGH", n])
    if len(rs) < n:
        rs += rows(con, sql, ["MEDIUM", n - len(rs)])
    for r in rs:
        r["facility"] = facility_short(r["facility"])
        r["ensemble_prob"] = round(r["ensemble_prob"], 4) if r["ensemble_prob"] is not None else None
        r["top_reasons"] = [{"feature": t.get("feature"), "label": t.get("label")} for t in (parse_json(r["top_reasons"]) or [])[:3]]
    return rs


def data_quality(con) -> dict:
    if not has_table(con, "mart_data_quality"):
        return {}
    allr = rows(con, "SELECT metric, value, threshold, status, district_code, facility_id FROM mart_data_quality")
    status = Counter(r["status"] for r in allr if r["status"] != "info")
    nat = {r["metric"]: r for r in allr if r["facility_id"] is None and r["district_code"] in (None, "RW")}
    pick = lambda m: round(nat[m]["value"], 1) if m in nat and nat[m]["value"] is not None else None  # noqa: E731
    raw_fail = [r["metric"] for r in allr if r["metric"].startswith("raw_") and r["status"] not in ("OK", "info")]
    mart = rows(con, "SELECT status, count(*) AS n FROM dq_mart_results GROUP BY 1") if has_table(con, "dq_mart_results") else []
    return {"checks_ok": status.get("OK", 0), "checks_low": status.get("LOW", 0), "checks_warn": status.get("WARN", 0),
            "freshness_days": pick("raw_freshness_days"), "hp_tested_pct": pick("hp_tested_pct"),
            "completeness_smoking_pct": pick("completeness_smoking_pct"),
            "completeness_family_hx_pct": pick("completeness_family_hx_pct"),
            "duplicates_merged": pick("duplicates_merged"), "raw_checks_failing": raw_fail,
            "mart_checks": {r["status"]: r["n"] for r in mart}}


def write_snapshot(snap: dict, dated: bool = True) -> Path:
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    SNAP_LATEST.write_text(json.dumps(snap, indent=1, default=str) + "\n")
    if dated:  # dated copies are gitignored; useful for local day-over-day diffs
        (SNAP_DIR / f"{dt.date.today().isoformat()}.json").write_text(json.dumps(snap, indent=1, default=str) + "\n")
    return SNAP_LATEST


def refresh_snapshot() -> Path | None:
    con, cur = connect()
    if con is None:
        return None
    try:
        return write_snapshot(build_snapshot(con, cur))
    finally:
        con.close()


def load_snapshot() -> dict | None:
    try:
        return json.load(open(SNAP_LATEST))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
