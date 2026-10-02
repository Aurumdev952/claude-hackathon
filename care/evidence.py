"""Evidence rules (docs/contracts/v3-loop.md §4.1): which EMR fact closes which care task, and what it means.

A task completes with the earliest matching fact dated on or after its opening *date* (and not after the reconcile end):
a fact on the calendar day the task opens counts even when it is earlier in the day than `opens_at` (sim ticks end at
23:59:59, so a task that opens "today" must accept today's clinic visit), but never a fact from before the task was
created (`created_sim`), so a result-discussion step spawned at 14:00 is not closed by that morning's visit. A fact
closes at most one task per plan (keyed by `fact_key`), so chained tasks (chemo cycles, test then test of cure) never
reuse it.

Facts come from the work DuckDB (`raw_*` unioned with `stg_*`, so rows written this tick count before the next
staging run) or, as a fallback, from the serve DB `pt_timeline`.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

from shared.concepts import C

# kind: enc (encounter_type), obs (concept_id[, value_coded]), drug (drug concept on a drug order)
RULES: dict[str, list[dict]] = {
    "ENDOSCOPY": [{"kind": "enc", "codes": (5,)}],
    "PATHOLOGY_REVIEW": [{"kind": "enc", "codes": (6,)}],
    "RESULT_DISCUSSED": [{"kind": "enc", "codes": (3, 7)}],
    "HP_TEST": [{"kind": "obs", "codes": (C.HP_STOOL, C.HP_SERO, C.HP_UBT, C.RUT)}],
    "HP_TEST_OF_CURE": [{"kind": "obs", "codes": (C.HP_STOOL, C.HP_SERO, C.HP_UBT, C.RUT)}],
    "HB_RECHECK": [{"kind": "obs", "codes": (C.HB,)}],
    "B12_CHECK": [{"kind": "obs", "codes": (C.B12,)}],
    "FOLLOWUP_VISIT": [{"kind": "enc", "codes": (3, 7)}],
    "HP_TREATMENT": [{"kind": "drug", "codes": (C.AMOX, C.CLARI, C.METRO, C.BISMUTH)}],
    "IRON_COURSE": [{"kind": "drug", "codes": (C.IRON,)}],
    "SURGERY": [{"kind": "obs", "codes": (C.GASTRECTOMY,), "value_coded": C.YES}],
    "CHEMO_CYCLE": [{"kind": "obs", "codes": (C.CHEMO_CYCLE,)}],
    "CHW_VISIT": [{"kind": "enc", "codes": (17,)}],
    # not listed in the contract table; same principle (one rule, earliest fact on/after opens_at)
    "ONCOLOGY_INTAKE": [{"kind": "enc", "codes": (7,)}],
    "STAGING_CT": [{"kind": "obs", "codes": (C.STAGE_SET,)}],
    "MDT_PLAN": [{"kind": "obs", "codes": (C.TX_INTENT,)}],
    "B12_INJECTION": [{"kind": "drug", "codes": (C.CYANOCOBALAMIN,)}],
    "NUTRITION_REVIEW": [{"kind": "obs", "codes": (C.WEIGHT, C.ALB)}],
    "SURVEILLANCE_IMAGING": [{"kind": "obs", "codes": (C.SURV_IMAGING,)}],
    "PAIN_REVIEW": [{"kind": "enc", "codes": (3, 7)}, {"kind": "drug", "codes": (C.MORPHINE,)}],
}
# serve-DB fallback only: chemo cycles before concept 5063 existed are visible as chemo drug orders
SERVE_EXTRA = {"CHEMO_CYCLE": [{"kind": "drug", "codes": (C.CAPECITABINE, C.OXALIPLATIN)}]}

ENC_TYPES = sorted({c for rs in RULES.values() for r in rs if r["kind"] == "enc" for c in r["codes"]})
OBS_CODES = sorted({c for rs in RULES.values() for r in rs if r["kind"] == "obs" for c in r["codes"]})
DRUG_CODES = sorted({c for rs in list(RULES.values()) + list(SERVE_EXTRA.values()) for r in rs if r["kind"] == "drug"
                     for c in r["codes"]})
# coded details looked up inside matched encounters (endoscopy impression, histology)
DETAIL_CODES = (C.ENDO_IMPRESSION, C.HISTOLOGY, C.BIOPSY)

ENDO_RESULT = {7110: "NORMAL", 7111: "GASTRITIS", 7112: "ULCER", 7113: "SUSPICIOUS", 7114: "ATROPHY_IM"}
HISTO_RESULT = {7130: "CANCER_FOUND", 7131: "GASTRITIS", 7132: "INTESTINAL_METAPLASIA", 7133: "DYSPLASIA",
                7134: "OTHER_FINDING", 7135: "OTHER_FINDING", 7136: "BENIGN_ULCER", 7137: "NORMAL"}
INTENT_RESULT = {7200: "CURATIVE", 7201: "PALLIATIVE", 7202: "BSC"}


def _has(con, table: str) -> bool:
    try:
        return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [table]).fetchone()[0] > 0
    except Exception:
        return False


def _ids(xs) -> str:
    return ",".join(str(int(x)) for x in sorted(set(xs))) or "NULL"


def fetch_facts(con, patient_ids, since: dt.datetime, until: dt.datetime) -> dict[int, list[dict]]:
    """All candidate evidence facts for these patients dated in [since, until], oldest first.

    Works on the work DB (raw_* + stg_*) and on the serve DB (pt_timeline)."""
    pids = _ids(patient_ids)
    if pids == "NULL":
        return {}
    args = [since, until]
    parts: list[str] = []
    if _has(con, "raw_encounter") or _has(con, "stg_encounter"):
        for t, vcol in (("raw_encounter", "coalesce(voided, 0) = 0"), ("stg_encounter", "TRUE")):
            if _has(con, t):
                parts.append(f"""SELECT 'encounter' AS tbl, encounter_id AS id, patient_id, 'enc' AS kind,
                                        encounter_type AS code, NULL::INT AS value_coded, NULL::DOUBLE AS value_numeric,
                                        encounter_datetime AS date, encounter_id AS enc FROM {t}
                                 WHERE {vcol} AND patient_id IN ({pids}) AND encounter_type IN ({_ids(ENC_TYPES)})
                                   AND encounter_datetime BETWEEN ? AND ?""")
        for t, vcol in (("raw_obs", "coalesce(voided, 0) = 0"), ("stg_obs", "TRUE")):
            if _has(con, t):
                parts.append(f"""SELECT 'obs', obs_id, person_id, 'obs', concept_id, value_coded, value_numeric,
                                        obs_datetime, encounter_id FROM {t}
                                 WHERE {vcol} AND person_id IN ({pids}) AND concept_id IN ({_ids(OBS_CODES)})
                                   AND obs_datetime BETWEEN ? AND ?""")
        for t, vcol in (("raw_orders", "coalesce(o.voided, 0) = 0"), ("stg_orders", "TRUE")):
            if _has(con, t) and _has(con, "raw_drug_order"):
                parts.append(f"""SELECT 'drug_order', o.order_id, o.patient_id, 'drug', o.concept_id, NULL, NULL,
                                        o.date_activated, o.encounter_id FROM {t} o SEMI JOIN raw_drug_order d USING (order_id)
                                 WHERE {vcol} AND o.patient_id IN ({pids}) AND o.concept_id IN ({_ids(DRUG_CODES)})
                                   AND o.date_activated BETWEEN ? AND ?""")
        sql = " UNION ".join(parts)
        rows = con.execute(f"SELECT DISTINCT * FROM ({sql}) ORDER BY date, id", args * len(parts)).fetchall()
        facts = _group(rows)
        _details_work(con, facts)
        return facts
    if _has(con, "pt_timeline"):
        return _facts_serve(con, pids, since, until)
    return {}


def _group(rows) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = defaultdict(list)
    for tbl, i, pid, kind, code, vc, vn, date, enc in rows:
        out[int(pid)].append({"table": tbl, "id": int(i), "kind": kind, "code": int(code), "value_coded": vc,
                              "value_numeric": vn, "date": date, "encounter_id": int(enc) if enc is not None else None})
    return out


def _details_work(con, facts: dict[int, list[dict]]):
    encs = {f["encounter_id"] for fs in facts.values() for f in fs if f["kind"] == "enc" and f["code"] in (5, 6)}
    if not encs:
        return
    det: dict[int, dict] = defaultdict(dict)
    for t, vcol in (("raw_obs", "coalesce(voided, 0) = 0"), ("stg_obs", "TRUE")):
        if _has(con, t):
            for enc, cid, vc in con.execute(f"""SELECT encounter_id, concept_id, value_coded FROM {t}
                                               WHERE {vcol} AND encounter_id IN ({_ids(encs)})
                                                 AND concept_id IN ({_ids(DETAIL_CODES)})""").fetchall():
                det[int(enc)][int(cid)] = vc
    for fs in facts.values():
        for f in fs:
            if f["kind"] == "enc" and f["encounter_id"] in det:
                f["details"] = det[f["encounter_id"]]


def _facts_serve(con, pids: str, since, until) -> dict[int, list[dict]]:
    rows = con.execute(f"""SELECT event_type, patient_id, concept_id, value_num, value_text, ts, encounter_id FROM pt_timeline
                           WHERE patient_id IN ({pids}) AND ts BETWEEN ? AND ?
                             AND event_type IN ('VISIT', 'LAB', 'VITAL', 'DRUG', 'ENDOSCOPY', 'PATHOLOGY', 'STAGING')
                           ORDER BY ts""", [since, until]).fetchall()
    out: dict[int, list[dict]] = defaultdict(list)
    det: dict[int, dict] = defaultdict(dict)
    for et, pid, cid, vn, vt, ts, enc in rows:
        enc = int(enc) if enc is not None else None
        if et == "ENDOSCOPY":
            det[enc][C.ENDO_IMPRESSION] = cid
            continue
        if et == "PATHOLOGY":
            det[enc][C.HISTOLOGY] = cid
            continue
        if et == "STAGING":
            out[int(pid)].append({"table": "obs", "id": enc or 0, "kind": "obs", "code": C.STAGE_SET, "value_coded": cid,
                                  "value_numeric": None, "date": ts, "encounter_id": enc, "source": "pt_timeline",
                                  "key": _serve_key("obs", pid, enc, C.STAGE_SET, ts, cid)})
            continue
        kind = {"VISIT": "enc", "LAB": "obs", "VITAL": "obs", "DRUG": "drug"}[et]
        if (kind == "enc" and cid not in ENC_TYPES) or (kind == "obs" and cid not in OBS_CODES) or \
                (kind == "drug" and cid not in DRUG_CODES):
            continue
        vc = None
        if kind == "obs" and cid in (C.HP_STOOL, C.HP_SERO, C.HP_UBT, C.RUT):
            vc = C.POS if (vt or "").lower().startswith("pos") else C.NEG if (vt or "").lower().startswith("neg") else None
        table = {"enc": "encounter", "obs": "obs", "drug": "drug_order"}[kind]
        # pt_timeline has no obs/order ids: an encounter is unique by its id, an obs or drug order by
        # (table, patient, encounter, concept, time, value); `id` stays the encounter id for display
        key = f"encounter:{enc}" if kind == "enc" and enc is not None else _serve_key(table, pid, enc, cid, ts, vn if vn is not None else vt)
        out[int(pid)].append({"table": table, "id": enc or 0, "kind": kind, "code": int(cid), "value_coded": vc,
                              "value_numeric": vn, "date": ts, "encounter_id": enc, "source": "pt_timeline", "key": key})
    for fs in out.values():
        for f in fs:
            if f["kind"] == "enc" and f["encounter_id"] in det:
                f["details"] = det[f["encounter_id"]]
    return out


def _serve_key(table: str, pid, enc, cid, ts, value) -> str:
    t = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
    return f"{table}:{int(pid)}:{enc if enc is not None else '-'}:{int(cid)}:{t}:{value}"


def fact_key(f: dict) -> str:
    """Unique identity of an evidence fact (work DB: table + real row id; serve DB: a composite key)."""
    return f.get("key") or f"{f['table']}:{f['id']}"


def evidence_key(ev: dict) -> str | None:
    """`fact_key` of a stored task evidence json (None for manual completions without an EMR fact)."""
    if not ev or not ev.get("table") or ev.get("id") is None:
        return ev.get("key") if ev else None
    return ev.get("key") or f"{ev['table']}:{ev['id']}"


def lower_bound(task: dict) -> dt.datetime:
    """Earliest fact time that may close the task: the start of its opening day, but never before it was created."""
    opens = dt.datetime.fromisoformat(str(task["opens_at"])[:19])
    lo = dt.datetime.combine(opens.date(), dt.time())
    created = task.get("created_sim")
    if created:
        lo = max(lo, dt.datetime.fromisoformat(str(created)[:19]))
    return min(lo, opens)


def rules_for(task_type: str, serve: bool = False) -> list[dict]:
    return RULES.get(task_type, []) + (SERVE_EXTRA.get(task_type, []) if serve else [])


def matches(task_type: str, fact: dict) -> bool:
    for r in rules_for(task_type, serve=fact.get("source") == "pt_timeline"):
        if fact["kind"] == r["kind"] and fact["code"] in r["codes"]:
            if "value_coded" in r and fact.get("value_coded") != r["value_coded"]:
                continue
            return True
    return False


def find(task: dict, facts: list[dict], used: set, until: dt.datetime) -> dict | None:
    """Earliest unused fact matching the task's rule, dated within [lower_bound(task), until] (see module docstring).
    `used` holds `fact_key`s already used by this plan."""
    lo = lower_bound(task)
    for f in facts:
        d = f["date"] if isinstance(f["date"], dt.datetime) else dt.datetime.fromisoformat(str(f["date"]))
        if d < lo or d > until:
            continue
        if fact_key(f) in used:
            continue
        if matches(task["type"], f):
            return f
    return None


def result_of(task_type: str, fact: dict, context: dict | None = None) -> str:
    """Interpret the fact: NEGATIVE|POSITIVE|SUSPICIOUS|CANCER_FOUND|NORMAL|LOW|FALLING|IMPROVING|CURATIVE|... ."""
    ctx = context or {}
    vc, vn, det = fact.get("value_coded"), fact.get("value_numeric"), fact.get("details") or {}
    if task_type in ("HP_TEST", "HP_TEST_OF_CURE"):
        return "POSITIVE" if vc == C.POS else "NEGATIVE" if vc == C.NEG else "INDETERMINATE"
    if task_type == "ENDOSCOPY":
        return ENDO_RESULT.get(det.get(C.ENDO_IMPRESSION), "DONE")  # SUSPICIOUS (7113) -> pathology review
    if task_type == "PATHOLOGY_REVIEW":
        return HISTO_RESULT.get(det.get(C.HISTOLOGY), "REVIEWED")
    if task_type == "HB_RECHECK" and vn is not None:
        base = ctx.get("hb_baseline")
        if base is not None and vn < base - 0.5:
            return "FALLING"
        if vn < 11.0:
            return "LOW"
        return "IMPROVING" if base is not None and vn > base + 0.5 else "STABLE"
    if task_type == "B12_CHECK" and vn is not None:
        return "LOW" if vn < 200 else "NORMAL"
    if task_type == "MDT_PLAN":
        return INTENT_RESULT.get(vc, "PLANNED")
    if task_type == "SURVEILLANCE_IMAGING":
        return "SUSPICIOUS" if vc == C.SUSPICIOUS else "NO_EVIDENCE_OF_DISEASE" if vc == C.NED else "DONE"
    return "DONE"


def as_evidence(fact: dict) -> dict:
    d = fact["date"]
    value = fact.get("value_coded") if fact.get("value_coded") is not None else fact.get("value_numeric")
    if value is None and fact.get("details"):
        value = next(iter(fact["details"].values()))
    out = {"table": fact["table"], "id": fact["id"], "concept_id": fact["code"], "value": value,
           "date": d.isoformat() if hasattr(d, "isoformat") else str(d), "encounter_id": fact.get("encounter_id")}
    if fact.get("key"):
        out["key"] = fact["key"]
    return out
