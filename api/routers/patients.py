"""Doctor endpoints (SPEC §14.2) + the 3D Case Analysis payload (SPEC v1.1). Patient-level data is scoped to the
doctor's facility through pt_patient_facility (home facility, its district hospital, recent GI encounters there)."""
from __future__ import annotations

import datetime as dt
import math

from fastapi import APIRouter, Body, Depends, Query

from shared.config import body_map

from .. import app_state
from ..deps import SERVE, APIError, Role, doctor, envelope, parse_json, role
from ..llm.summaries import explain_patient

router = APIRouter()
STATUSES = ("NEW", "ACKNOWLEDGED", "REFERRED", "DISMISSED")
VITALS = {3000: "Weight", 3002: "BMI", 3003: "Systolic BP", 3004: "Diastolic BP", 3005: "Pulse", 3006: "Temperature", 3007: "Respiratory rate"}
LABS = {3100: "Haemoglobin", 3101: "MCV", 3102: "Ferritin", 3103: "WBC", 3104: "Platelets", 3107: "Albumin", 3109: "Creatinine",
        3105: "ALT", 3110: "Random glucose", 3111: "HbA1c"}
CODED_LABS = {3120: "H. pylori stool antigen", 3121: "H. pylori serology", 3122: "H. pylori breath test", 3112: "Malaria RDT",
              3123: "Faecal occult blood"}


def d(r: Role = Depends(role)) -> Role:
    return doctor(r)


def _check_access(patient_id: int, r: Role):
    ok = SERVE.one("SELECT 1 AS ok FROM pt_patient_facility WHERE patient_id = ? AND facility_id = ?", [patient_id, r.facility_id])
    if not ok:
        raise APIError(404, "NOT_FOUND", "Patient not found at this facility")


def _alerts_for(where: str, params: list) -> list[dict]:
    rows = SERVE.rows(f"""SELECT a.*, p.display_id, p.given_name || ' ' || p.family_name AS name FROM pt_alerts a
                          JOIN pt_patient p USING (patient_id) WHERE {where} ORDER BY a.created_at DESC""", params) \
        if SERVE.has_table("pt_alerts") else []
    st = app_state.alert_statuses([a["alert_id"] for a in rows])
    for a in rows:
        a["reasons"] = parse_json(a["reasons"])
        if a["alert_id"] in st:
            a.update({"status": st[a["alert_id"]]["status"], "note": st[a["alert_id"]]["note"],
                      "status_updated_at": st[a["alert_id"]]["updated_at"]})
    return rows


@router.get("/patients")
def patients(risk_band: str | None = None, q: str | None = None, status: str = "flagged", page: int = 1,
             page_size: int = Query(25, le=100), r: Role = Depends(d)):
    if status not in ("flagged", "diagnosed", "all"):
        raise APIError(400, "INVALID_FILTER", "status must be flagged|diagnosed|all")
    has_risk = SERVE.has_table("pt_risk")
    where = ["f.facility_id = ?"]
    params: list = [r.facility_id]
    if status == "flagged":
        where.append("NOT p.is_case" + (" AND rk.patient_id IS NOT NULL" if has_risk else ""))
    elif status == "diagnosed":
        where.append("p.is_case")
    if risk_band and has_risk:
        where.append("rk.risk_band = ?")
        params.append(risk_band.upper())
    if q:
        where.append("(lower(p.given_name || ' ' || p.family_name) LIKE ? OR lower(p.display_id) LIKE ?)")
        params += [f"%{q.lower()}%"] * 2
    risk_cols = ("rk.risk_band, rk.ensemble_prob, rk.t1_score, rk.top_reasons, rk.rank_in_facility" if has_risk
                 else "NULL AS risk_band, NULL AS ensemble_prob, NULL AS t1_score, NULL AS top_reasons, NULL AS rank_in_facility")
    risk_join = "LEFT JOIN pt_risk rk USING (patient_id)" if has_risk else ""
    base = f"""FROM pt_patient_facility f JOIN pt_patient p USING (patient_id) {risk_join} WHERE {' AND '.join(where)}"""
    total = SERVE.one(f"SELECT count(*) AS n {base}", params)["n"]
    order = "rk.ensemble_prob DESC NULLS LAST" if has_risk and status != "diagnosed" else "p.dx_date DESC NULLS LAST"
    rows = SERVE.rows(f"""SELECT p.patient_id, p.display_id, p.given_name || ' ' || p.family_name AS name, p.sex, p.age, p.district_code,
                                 p.is_case, p.case_status, p.dx_date, p.last_encounter_date AS last_visit, {risk_cols}
                          {base} ORDER BY {order} LIMIT ? OFFSET ?""", params + [page_size, (page - 1) * page_size])
    ids = [x["patient_id"] for x in rows]
    open_alerts = {}
    if ids and SERVE.has_table("pt_alerts"):
        al = _alerts_for(f"a.patient_id IN ({','.join('?' * len(ids))})", ids)
        for a in al:
            if a["status"] in ("NEW", "ACKNOWLEDGED"):
                open_alerts[a["patient_id"]] = open_alerts.get(a["patient_id"], 0) + 1
    for x in rows:
        x["top_reasons"] = (parse_json(x["top_reasons"]) or [])[:2]
        x["open_alerts"] = open_alerts.get(x["patient_id"], 0)
    return envelope(rows, page=page, page_size=page_size, total=total)


def _header(pid: int) -> dict:
    h = SERVE.one("""SELECT p.*, d.name AS district_name, d.province, l.name AS home_facility_name FROM pt_patient p
                     LEFT JOIN ref_district d USING (district_code) LEFT JOIN core_dim_location l ON l.location_id = p.home_facility_id
                     WHERE p.patient_id = ?""", [pid])
    if not h:
        raise APIError(404, "NOT_FOUND", "Patient not found")
    h["name"] = f"{h.pop('given_name')} {h.pop('family_name')}"
    return h


def _risk(pid: int) -> dict | None:
    if not SERVE.has_table("pt_risk"):
        return None
    r = SERVE.one("SELECT * FROM pt_risk WHERE patient_id = ?", [pid])
    if r:
        r["top_reasons"] = parse_json(r["top_reasons"]) or []
        r["t3_attention"] = parse_json(r["t3_attention"]) or []
    return r


@router.get("/patients/{patient_id}")
def patient(patient_id: int, r: Role = Depends(d)):
    _check_access(patient_id, r)
    return envelope({**_header(patient_id), "risk": _risk(patient_id)})


@router.get("/patients/{patient_id}/timeline")
def timeline(patient_id: int, from_: str | None = Query(None, alias="from"), to: str | None = None, types: str | None = None,
             r: Role = Depends(d)):
    _check_access(patient_id, r)
    where, params = ["t.patient_id = ?"], [patient_id]
    if from_:
        where.append("t.ts >= CAST(? AS TIMESTAMP)")
        params.append(from_)
    if to:
        where.append("t.ts <= CAST(? AS TIMESTAMP)")
        params.append(to)
    if types:
        tl = [x.strip().upper() for x in types.split(",")]
        where.append(f"t.event_type IN ({','.join('?' * len(tl))})")
        params += tl
    ev = SERVE.rows(f"""SELECT t.ts, t.event_type, t.concept_id, t.label, t.value_num, t.value_text, t.unit, t.is_abnormal,
                               t.organ_ids, l.name AS facility FROM pt_timeline t LEFT JOIN core_dim_location l ON l.location_id = t.facility_id
                        WHERE {' AND '.join(where)} ORDER BY t.ts""", params)
    risk = _risk(patient_id)
    hl = _highlights(ev, risk)
    for i, e in enumerate(ev):
        e["highlight"] = i in hl
    series = {"hb": [{"ts": e["ts"], "value": e["value_num"]} for e in ev if e["event_type"] == "LAB" and e["concept_id"] == 3100],
              "weight": [{"ts": e["ts"], "value": e["value_num"]} for e in ev if e["event_type"] == "VITAL" and e["concept_id"] == 3000]}
    return envelope({"patient_id": patient_id, "events": ev, "series": series})


def _highlights(ev: list[dict], risk: dict | None) -> set[int]:
    """Indices of events matching Tier 3 attributions (token type/concept + days-before) or SHAP reason features."""
    out = set()
    if not risk:
        return out
    asof = dt.datetime.fromisoformat(str(risk["as_of"]))
    tmap = {"V": "VISIT", "D": "DIAGNOSIS", "S": "SYMPTOM", "L": "LAB", "W": "VITAL", "R": "DRUG"}
    for a in risk.get("t3_attention") or []:
        parts = a["token"].split(":")
        if len(parts) < 2:
            continue
        et, cid = tmap.get(parts[0]), int(parts[1]) if parts[1].isdigit() else None
        best, best_gap = None, 1e9
        for i, e in enumerate(ev):
            if e["event_type"] == et and e["concept_id"] == cid:
                gap = abs((asof - dt.datetime.fromisoformat(e["ts"])).days - a["days_before"])
                if gap < best_gap:
                    best, best_gap = i, gap
        if best is not None and best_gap <= 3:
            out.add(best)
    feats = {x["feature"] for x in risk.get("top_reasons") or []}
    if feats & {"hb_drop_12m", "hb_slope_12m", "hb_last", "hb_min_12m", "anaemia_flag"}:
        hbs = [i for i, e in enumerate(ev) if e["event_type"] == "LAB" and e["concept_id"] == 3100]
        out.update(hbs[-2:])
    if feats & {"sx_dysphagia", "sx_weight_loss", "sx_mass", "n_alarm_features_12m"}:
        out.update(i for i, e in enumerate(ev) if e["event_type"] == "SYMPTOM" and e["concept_id"] in (2203, 2205, 2213))
    return out


@router.get("/patients/{patient_id}/risk")
def risk(patient_id: int, r: Role = Depends(d)):
    _check_access(patient_id, r)
    cur = _risk(patient_id)
    hist = SERVE.rows("""SELECT as_of, t1_score, t2_prob, t3_prob, ensemble_prob, risk_band FROM ml_risk_history
                         WHERE patient_id = ? ORDER BY as_of""", [patient_id]) if SERVE.has_table("ml_risk_history") else []
    thr = SERVE.one("SELECT * FROM ml_thresholds") if SERVE.has_table("ml_thresholds") else None
    return envelope({"current": cur, "history": hist, "thresholds": thr})


@router.post("/patients/{patient_id}/explain")
def explain(patient_id: int, r: Role = Depends(d)):
    _check_access(patient_id, r)
    return envelope(explain_patient(build_case(patient_id, r)))


@router.get("/patients/{patient_id}/notes")
def notes(patient_id: int, r: Role = Depends(d)):
    _check_access(patient_id, r)
    return envelope(app_state.case_notes(patient_id))


@router.post("/patients/{patient_id}/notes")
def add_note(patient_id: int, body: dict = Body(...), r: Role = Depends(d)):
    _check_access(patient_id, r)
    note = (body.get("note") or "").strip()
    if not note or len(note) > 2000:
        raise APIError(400, "INVALID_NOTE", "note must be 1-2000 characters")
    return envelope(app_state.add_case_note(patient_id, r.facility_id, note))


@router.get("/alerts")
def alerts(status: str | None = None, severity: str | None = None, r: Role = Depends(d)):
    rows = _alerts_for("a.patient_id IN (SELECT patient_id FROM pt_patient_facility WHERE facility_id = ?)", [r.facility_id])
    if status:
        rows = [a for a in rows if a["status"] == status.upper()]
    if severity:
        rows = [a for a in rows if a["severity"] == severity.upper()]
    return envelope(rows)


@router.patch("/alerts/{alert_id}")
def patch_alert(alert_id: str, body: dict = Body(...), r: Role = Depends(d)):
    st = (body.get("status") or "").upper()
    if st not in STATUSES:
        raise APIError(400, "INVALID_STATUS", f"status must be one of {list(STATUSES)}")
    if st == "DISMISSED" and not (body.get("reason") or body.get("note")):
        raise APIError(400, "REASON_REQUIRED", "Dismissing an alert needs a reason")
    a = SERVE.one("""SELECT a.alert_id, a.patient_id FROM pt_alerts a JOIN pt_patient_facility f USING (patient_id)
                     WHERE a.alert_id = ? AND f.facility_id = ?""", [alert_id, r.facility_id]) if SERVE.has_table("pt_alerts") else None
    if not a:
        raise APIError(404, "NOT_FOUND", "Alert not found at this facility")
    app_state.set_alert_status(alert_id, st, body.get("note"), body.get("reason"), r.facility_id)
    return envelope(_alerts_for("a.alert_id = ?", [alert_id])[0])


# ------------------------------------------------------------------------------------------- 3D case analysis
def _months_between(a: str, b: dt.datetime) -> float:
    return (b - dt.datetime.fromisoformat(a)).days / 30.44


@router.get("/patients/{patient_id}/case")
def case(patient_id: int, months: int = Query(36, ge=6, le=120), r: Role = Depends(d)):
    _check_access(patient_id, r)
    return envelope(build_case(patient_id, r, months))


def build_case(patient_id: int, r: Role, months: int = 36) -> dict:
    header = _header(patient_id)
    sim = dt.datetime.fromisoformat(SERVE.meta()["sim_time"] or "2026-06-30T23:59:59")
    end = min(sim, dt.datetime.fromisoformat(header["death_date"])) if header.get("death_date") else sim
    start = end - dt.timedelta(days=int(months * 30.44))
    ev = SERVE.rows("""SELECT t.ts, t.event_type, t.concept_id, t.label, t.value_num, t.value_text, t.unit, t.is_abnormal,
                              t.organ_ids, t.organ_weight, t.region, t.facility_id, l.name AS facility
                       FROM pt_timeline t LEFT JOIN core_dim_location l ON l.location_id = t.facility_id
                       WHERE t.patient_id = ? ORDER BY t.ts""", [patient_id])
    window = [e for e in ev if e["ts"] >= start.isoformat()]
    bm = body_map()
    # ---- conditions: diagnoses, symptoms and abnormal labs aggregated per concept, mapped to organs
    conds: dict[tuple, dict] = {}
    for e in ev:
        if e["event_type"] not in ("DIAGNOSIS", "SYMPTOM", "LAB", "ENDOSCOPY", "PATHOLOGY", "STAGING") or not e["organ_ids"]:
            continue
        if e["event_type"] == "LAB" and not e["is_abnormal"]:
            continue
        cat = {"DIAGNOSIS": "diagnosis", "SYMPTOM": "symptom", "LAB": "lab"}.get(e["event_type"], "procedure")
        k = (cat, e["concept_id"])
        c = conds.setdefault(k, {"concept_id": e["concept_id"], "label": e["label"], "category": cat, "organ_ids": e["organ_ids"],
                                 "weight": e["organ_weight"] or 0.3, "region": e["region"], "first_ts": e["ts"], "count": 0,
                                 "certainty": None, "is_alarm": False})
        c["count"] += 1
        c["last_ts"] = e["ts"]
        if cat == "diagnosis":
            c["certainty"] = e["value_text"]
        c["is_alarm"] = c["is_alarm"] or bool(e["is_abnormal"])
    conditions = []
    for c in conds.values():
        ms = _months_between(c["last_ts"], end)
        recency = math.exp(-max(ms, 0) / 12.0)
        c["months_since_last"] = round(ms, 1)
        c["severity"] = round(min(1.0, c["weight"] * recency * (1 + 0.15 * math.log1p(c["count"] - 1)) * (1.2 if c["is_alarm"] else 1.0)), 3)
        conditions.append(c)
    conditions.sort(key=lambda c: -c["severity"])
    # ---- organ scores
    organs = {}
    for c in conditions:
        for o in c["organ_ids"]:
            g = organs.setdefault(o, {"organ_id": o, "label": bm["organs"].get(o, {}).get("label", o), "score": 0.0, "conditions": []})
            g["score"] = max(g["score"], c["severity"])
            g["conditions"].append(c["label"])
    # ---- vitals and labs with series and trends
    def series_for(etype, cid):
        return [{"ts": e["ts"], "value": e["value_num"], "abnormal": e["is_abnormal"]} for e in ev
                if e["event_type"] == etype and e["concept_id"] == cid and e["value_num"] is not None]

    def summarise(etype, cid, name):
        s = series_for(etype, cid)
        if not s:
            return None
        last = s[-1]
        unit = next((e["unit"] for e in ev if e["event_type"] == etype and e["concept_id"] == cid), None)
        prev12 = [x for x in s if _months_between(x["ts"], dt.datetime.fromisoformat(last["ts"])) <= 12]
        chg = 100 * (last["value"] - prev12[0]["value"]) / prev12[0]["value"] if len(prev12) >= 2 and prev12[0]["value"] else None
        slope = None
        if len(prev12) >= 2:
            t0 = dt.datetime.fromisoformat(prev12[0]["ts"])
            xs = [(dt.datetime.fromisoformat(x["ts"]) - t0).days / 30.44 for x in prev12]
            ys = [x["value"] for x in prev12]
            mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
            den = sum((x - mx) ** 2 for x in xs)
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else None
        return {"concept_id": cid, "name": name, "unit": unit, "latest": last["value"], "latest_ts": last["ts"],
                "abnormal": bool(last["abnormal"]), "change_pct_12m": round(chg, 1) if chg is not None else None,
                "slope_per_month": round(slope, 3) if slope is not None else None, "n": len(s),
                "series": [x for x in s if x["ts"] >= start.isoformat()] or s[-6:]}

    vitals = [v for v in (summarise("VITAL", c, n) for c, n in VITALS.items()) if v]
    labs = [v for v in (summarise("LAB", c, n) for c, n in LABS.items()) if v]
    for cid, name in CODED_LABS.items():
        res = [e for e in ev if e["event_type"] == "LAB" and e["concept_id"] == cid]
        if res:
            labs.append({"concept_id": cid, "name": name, "unit": None, "latest": res[-1]["value_text"], "latest_ts": res[-1]["ts"],
                         "abnormal": bool(res[-1]["is_abnormal"]), "n": len(res), "series": [], "coded": True})
    # ---- tumour + spread (diagnosed patients only)
    tumour = None
    if header.get("is_case") and SERVE.has_table("pt_tumour"):
        tumour = SERVE.one("SELECT * FROM pt_tumour WHERE patient_id = ?", [patient_id])
        if tumour:
            n_level = {"N0": 0, "N1": 1, "N2": 2, "N3": 3}.get(tumour.get("n_stage") or "", 0)
            t_level = {"T1": 1, "T2": 2, "T3": 3, "T4a": 4, "T4b": 5}.get(tumour.get("t_stage") or "", 2)
            m1 = tumour.get("m_stage") == "M1" or tumour.get("stage_group") == "IV"
            tumour["spread"] = {"t_level": t_level, "lymph_node_groups": n_level,
                                "metastasis_sites": bm["spread"]["m1_sites"] if m1 else [],
                                "region": tumour.get("lesion_location") or "diffuse"}
    # ---- suspected region for flagged (undiagnosed) patients from region-tagged symptoms/diagnoses
    region_scores: dict[str, float] = {}
    for c in conditions:
        if c.get("region"):
            region_scores[c["region"]] = max(region_scores.get(c["region"], 0.0), c["severity"])
    suspected = None
    if not tumour and organs.get("stomach"):
        suspected = {"organ_id": "stomach", "region": max(region_scores, key=region_scores.get) if region_scores else "body",
                     "score": organs["stomach"]["score"], "region_scores": region_scores}
    meds = [e for e in window if e["event_type"] == "DRUG"]
    medications = {"ppi_courses_24m": sum(1 for e in meds if e["value_text"] in ("PPI_COURSE", "PPI_SHORT")
                                         and _months_between(e["ts"], end) <= 24),
                   "eradication_courses": sum(1 for e in meds if e["value_text"] == "HP_ERADICATION"),
                   "iron": sum(1 for e in meds if e["value_text"] == "IRON_THERAPY"),
                   "antimalarial": sum(1 for e in meds if e["value_text"] == "ANTIMALARIAL"),
                   "anthelminthic": sum(1 for e in meds if e["value_text"] == "ANTHELMINTHIC"),
                   "recent": [{"ts": e["ts"], "label": e["label"], "days": e["value_num"], "course_type": e["value_text"]} for e in meds[-12:]]}
    endoscopies = [e for e in ev if e["event_type"] == "ENDOSCOPY"]
    replay = [{"ts": e["ts"], "event_type": e["event_type"], "concept_id": e["concept_id"], "label": e["label"],
               "value_num": e["value_num"], "value_text": e["value_text"], "unit": e["unit"], "is_abnormal": e["is_abnormal"],
               "organ_ids": e["organ_ids"] or [], "weight": e["organ_weight"] or 0.0, "region": e["region"], "facility": e["facility"]}
              for e in window]
    risk_now = _risk(patient_id)
    return {"header": header, "risk": risk_now, "alerts": _alerts_for("a.patient_id = ?", [patient_id]), "tumour": tumour,
            "suspected": suspected, "conditions": conditions, "organs": sorted(organs.values(), key=lambda o: -o["score"]),
            "vitals": vitals, "labs": labs, "medications": medications,
            "endoscopies": [{"ts": e["ts"], "impression": e["label"], "location": e["value_text"], "size_mm": e["value_num"]} for e in endoscopies],
            "events": replay, "window": {"start": start.isoformat(), "end": end.isoformat(), "months": months},
            "notes": app_state.case_notes(patient_id),
            "body_map": {"organs": bm["organs"], "stomach_regions": list(bm["stomach_regions"].values())}}
