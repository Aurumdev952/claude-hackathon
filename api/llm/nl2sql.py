"""Ask the Data (SPEC §15.2): question -> SQL -> validated read-only execution -> chart spec -> grounded answer."""
from __future__ import annotations

import json
import time
from pathlib import Path

import yaml

from ..deps import SERVE
from . import rules
from .guardrails import UnsafeSQL, deidentify, numbers_supported, validate_sql
from .provider import LLMUnavailable, get_provider

SEMANTIC = yaml.safe_load(open(Path(__file__).parent / "semantic_layer.yaml"))
DOCTOR_TABLES = {"pt_risk", "pt_patient", "pt_alerts", "pt_patient_facility"}
FEW_SHOT_QUESTIONS = ["Which 5 districts had the highest age-standardised rate in 2024 among under-50s?",
                      "What is 1-year survival by stage?", "Which facilities test the fewest dyspepsia patients for H. pylori?",
                      "How has the under-50 rate changed since 2015?", "Which districts are High-High hotspots?"]


def allowed_tables(role: str) -> set[str]:
    base = {r["table_name"] for r in SERVE.rows(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mart_%' OR table_name LIKE 'ml_%'")}
    base |= {"ref_district", "ref_province"}
    return base | (DOCTOR_TABLES if role == "doctor" else set())


def _last_full_year() -> int:
    r = SERVE.one("SELECT max(year) AS y FROM mart_kpis WHERE NOT partial_year")
    return int(r["y"]) if r and r["y"] else 2025


def _scope_doctor(sql: str, facility_id: int) -> str:
    """Shadow pt_* tables with facility-filtered CTEs (applied after validation)."""
    f = int(facility_id)
    ctes = (f"pt_patient_facility AS (SELECT * FROM main.pt_patient_facility WHERE facility_id = {f}), "
            f"pt_patient AS (SELECT * FROM main.pt_patient WHERE patient_id IN (SELECT patient_id FROM pt_patient_facility)), "
            f"pt_risk AS (SELECT * FROM main.pt_risk WHERE patient_id IN (SELECT patient_id FROM pt_patient_facility)), "
            f"pt_alerts AS (SELECT * FROM main.pt_alerts WHERE patient_id IN (SELECT patient_id FROM pt_patient_facility))")
    return f"WITH {ctes} SELECT * FROM ({sql}) AS q"


def _prompt(role: str) -> str:
    tables = {k: v for k, v in SEMANTIC["tables"].items() if role == "doctor" or not k.startswith("pt_")}
    shots = []
    for q in FEW_SHOT_QUESTIONS:
        m = rules.match(q, "ministry", None, 2025)
        if m and m[1]:
            shots.append(f"Q: {q}\nSQL: {m[1]}")
    return ("You translate questions about a synthetic gastric cancer surveillance warehouse into ONE DuckDB SELECT statement.\n"
            "Use only these tables and columns:\n" + yaml.safe_dump(tables, sort_keys=False) +
            "\nGlossary:\n" + yaml.safe_dump(SEMANTIC["glossary"]) +
            "\nRules: return only SQL, no prose; never modify data; prefer asr when the user says rate; apply the default filters "
            "of mart_rates unless the question says otherwise.\n\nExamples:\n" + "\n\n".join(shots))


def _execute(sql: str, timeout_s: float = 5.0):
    """Read-only execution with a watchdog: DuckDB has no statement timeout, so interrupt() after timeout_s (SPEC §15.2)."""
    import threading
    con = SERVE.connection()
    timer = threading.Timer(timeout_s, con.interrupt)
    timer.start()
    try:
        t = time.time()
        r = con.execute(sql)
        cols = [d[0] for d in r.description]
        rows = r.fetchmany(1000)
        return cols, [list(x) for x in rows], time.time() - t
    finally:
        timer.cancel()
        con.close()


def chart_spec(cols: list[str], rows: list[list], question: str) -> dict:
    if len(rows) == 1 and len(cols) <= 2 and isinstance(rows[0][-1], (int, float)):
        return {"type": "kpi", "value": cols[-1], "title": question}
    num = [c for i, c in enumerate(cols) if rows and all(isinstance(r[i], (int, float)) or r[i] is None for r in rows)]
    if "year" in cols or "period" in cols:
        x = "year" if "year" in cols else "period"
        ys = [c for c in num if c not in (x,)]
        return {"type": "line", "x": x, "y": ys[0] if ys else None, "title": question}
    if "geo_code" in cols and num:
        return {"type": "choropleth", "geo": "geo_code", "value": [c for c in num if c != "geo_code"][0], "title": question}
    cat = [c for c in cols if c not in num]
    if cat and num:
        return {"type": "bar", "x": cat[0], "y": num[0], "title": question}
    return {"type": "table", "title": question}


def template_answer(cols, rows, intent: str) -> str:
    if not rows:
        return "No rows matched that question in the current data."
    def fmt(v):
        if isinstance(v, float):
            return f"{v:,.1f}"
        return str(v)
    if len(rows) == 1:
        return "; ".join(f"{c.replace('_', ' ')}: {fmt(v)}" for c, v in zip(cols, rows[0])) + "."
    label = next((i for i, c in enumerate(cols) if c in ("name", "geo_code", "group", "stage", "model_id", "sex", "year", "period", "display_id")), 0)
    val = next((i for i, c in enumerate(cols) if i != label and all(isinstance(r[i], (int, float)) or r[i] is None for r in rows)), None)
    items = [f"{fmt(r[label])} ({fmt(r[val])})" if val is not None else fmt(r[label]) for r in rows[:6]]
    more = f" and {len(rows) - 6} more" if len(rows) > 6 else ""
    head = cols[val].replace("_", " ") if val is not None else "result"
    return f"Top results by {head}: " + ", ".join(items) + more + "."


def caveats(cols, rows) -> list[str]:
    out = []
    if "cases" in cols:
        i = cols.index("cases")
        small = [r for r in rows if isinstance(r[i], (int, float)) and r[i] < 20]
        if small:
            out.append("Small numbers: some rows have fewer than 20 cases - interpret rates with care.")
    out.append("Synthetic data for demonstration - not real patients or real district statistics.")
    return out


def ask(question: str, role: str, facility_id: int | None) -> dict:
    t0 = time.time()
    provider = get_provider()
    allowed = allowed_tables(role)
    sql, intent, source = None, None, "rules"
    m = rules.match(question, role, facility_id, _last_full_year())
    if m and m[0] == "refuse":
        return {"answer": "I can only read aggregated data - I can't change or delete anything. Try one of the suggested questions.",
                "sql": None, "columns": [], "rows": [], "chart": None, "caveats": [], "validated_numbers": True,
                "refused": True, "suggestions": SEMANTIC["suggested_questions"][role], "latency_ms": int(1000 * (time.time() - t0))}
    if provider.name != "template":
        try:
            sql = provider.complete(_prompt(role), [{"role": "user", "content": question}], max_tokens=600, purpose="sql",
                                    timeout=12.0)
            source = provider.name
        except LLMUnavailable:
            sql = None
    if sql is None and m:
        intent, sql = m
    if sql is None:
        return {"answer": "I couldn't answer that safely - try one of these questions.", "sql": None, "columns": [], "rows": [],
                "chart": None, "caveats": [], "validated_numbers": True, "suggestions": SEMANTIC["suggested_questions"][role],
                "latency_ms": int(1000 * (time.time() - t0))}
    err = None
    for attempt in range(2):
        try:
            safe = validate_sql(sql, role, allowed)
            run = _scope_doctor(safe, facility_id) if role == "doctor" and any(t in safe.lower() for t in DOCTOR_TABLES) else safe
            cols, rows, _ = _execute(run)
            break
        except (UnsafeSQL, Exception) as e:  # one repair attempt with the error message (SPEC §15.2 step 6)
            err = str(e)
            if attempt == 0 and provider.name != "template" and source != "rules":
                try:
                    sql = provider.complete(_prompt(role), [{"role": "user", "content": question},
                                                            {"role": "assistant", "content": sql},
                                                            {"role": "user", "content": f"That failed: {err}. Return corrected SQL only."}],
                                            max_tokens=600, purpose="sql", timeout=12.0)
                    continue
                except LLMUnavailable:
                    pass
            if m and source != "rules":
                intent, sql, source = m[0], m[1], "rules"
                continue
            return {"answer": "I couldn't answer that safely - try one of these questions.", "sql": sql, "error": err, "columns": [],
                    "rows": [], "chart": None, "caveats": [], "validated_numbers": True,
                    "suggestions": SEMANTIC["suggested_questions"][role], "latency_ms": int(1000 * (time.time() - t0))}
    rows = [[_jsonable(v) for v in r] for r in rows]
    answer = template_answer(cols, rows, intent or "")
    validated = True
    if provider.name != "template":
        payload = rows if role == "doctor" and not provider.remote else deidentify([dict(zip(cols, r)) for r in rows[:50]])
        try:
            text = provider.complete("Answer in at most 3 sentences using ONLY the numbers in the result rows. No causal claims.",
                                     [{"role": "user", "content": f"Question: {question}\nResult rows (JSON): {json.dumps(payload, default=str)}"}],
                                     max_tokens=300, purpose="text", timeout=20.0)
            nums = [v for r in rows for v in r if isinstance(v, (int, float))]
            if numbers_supported(text, nums):
                answer = text.strip()
            else:
                validated = False  # number check failed: keep the template answer
        except LLMUnavailable:
            pass
    return {"answer": answer, "sql": sql, "columns": cols, "rows": rows, "chart": chart_spec(cols, rows, question),
            "caveats": caveats(cols, rows), "validated_numbers": True if validated else False, "source": source,
            "latency_ms": int(1000 * (time.time() - t0))}


def _jsonable(v):
    import datetime as dt
    import math
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if hasattr(v, "item"):
        return v.item()
    return v
