"""Patient journey phases and recovery summary (plan §2d / §3, contract §5 pt_journey, pt_recovery).

Pure Python over plain dicts so the pipeline mart (`pipeline/marts/care.py`) and the API live fallback share one
implementation. Phases: Flagged, Approved, Notified, Seen, Endoscopy, Diagnosis, Staging, Treatment, Recovery,
Surveillance, Survivorship, Palliative, Deceased. Status: done | current | upcoming | missed.

Survivorship schedule (synthetic default from NCCN/JGCA/CSCO): recovery to 3 months after treatment, surveillance to
3 years after diagnosis (visits every 3 months), survivorship to 5 years (every 6 months).
"""
from __future__ import annotations

import datetime as dt
from typing import Any

PHASES = ["Flagged", "Approved", "Notified", "Seen", "Endoscopy", "Diagnosis", "Staging", "Treatment", "Recovery",
          "Surveillance", "Survivorship", "Palliative", "Deceased"]
PATIENT_LABELS = {"Flagged": "Check-up suggested", "Approved": "Plan agreed", "Notified": "Message received",
                  "Seen": "Clinic visit", "Endoscopy": "Stomach check-up", "Diagnosis": "Results",
                  "Staging": "Scans and planning", "Treatment": "Treatment", "Recovery": "Recovery",
                  "Surveillance": "Regular check-ups", "Survivorship": "Staying well", "Palliative": "Comfort care",
                  "Deceased": None}
TRIGGER_LABEL = {"RISK_BAND_HIGH": "High risk score", "ALARM_NO_SCOPE_90D": "Alarm features without endoscopy",
                 "HB_DROP": "Falling haemoglobin", "HP_POS_UNTREATED": "H. pylori untreated", "CARE_OVERDUE": "Care step overdue"}
REGIMEN_CYCLES = {"FLOT": 8, "CAPOX": 8, "FOLFOX": 12, "Other regimen": 6}
VISIT_TYPES_SEEN = (1, 2, 3, 7)


def _d(v) -> dt.datetime | None:
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v
    if isinstance(v, dt.date):
        return dt.datetime.combine(v, dt.time())
    s = str(v).replace("Z", "")[:19]
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        return None


def _iso(v: dt.datetime | None) -> str | None:
    return v.strftime("%Y-%m-%d") if v else None


def _status(start: dt.datetime | None, end: dt.datetime | None, now: dt.datetime) -> str:
    if start is None or start > now:
        return "upcoming"
    if end is not None and end <= now:
        return "done"
    return "current"


def compute(patient: dict, events: list[dict], *, treatment: list[dict] | None = None, ecog: list[dict] | None = None,
            tumour: dict | None = None, alerts: list[dict] | None = None, risk: dict | None = None,
            plans: list[dict] | None = None, first_notification: Any = None, now: Any) -> dict:
    """-> {"phases": [{phase, start, end, status, milestones}], "recovery": {...} | None}"""
    now = _d(now)
    treatment = sorted(treatment or [], key=lambda r: _d(r["date"]) or now)
    events = sorted(events or [], key=lambda e: _d(e["ts"]) or now)
    plans = sorted(plans or [], key=lambda p: str(p.get("approved_at")))
    alerts = sorted(alerts or [], key=lambda a: str(a.get("created_at")))
    dx = _d(patient.get("dx_date")) if patient.get("is_case") or patient.get("dx_date") else None
    death = _d(patient.get("death_date")) if patient.get("dead") or patient.get("death_date") else None
    if death and death > now:
        death = None
    flag_t = _d(alerts[0]["created_at"]) if alerts else _d((risk or {}).get("first_high_at"))
    plan_t = _d(plans[0]["approved_at"]) if plans else None
    if plan_t and (flag_t is None or flag_t > plan_t):
        flag_t = plan_t  # a plan approved straight from the record (or before the alert was re-raised)
    notif_t = _d(first_notification)
    tasks = [t for p in plans for t in (p.get("tasks") or [])]
    phases: list[dict] = []

    def add(name, start, end, status=None, milestones=None):
        phases.append({"phase": name, "start": _iso(start), "end": _iso(end),
                       "status": status or _status(start, end, now), "milestones": milestones or []})

    visits = [e for e in events if e["event_type"] == "VISIT"]
    endos = [e for e in events if e["event_type"] == "VISIT" and e["concept_id"] == 5]
    endo_imp = {e.get("encounter_id"): e.get("label") for e in events if e["event_type"] == "ENDOSCOPY"}
    pre = dx is None or (flag_t is not None and flag_t <= dx)
    # ---------------------------------------------------------------- screening part (flag -> endoscopy)
    if flag_t and pre:
        ms = [{"date": _iso(_d(a["created_at"])), "label": TRIGGER_LABEL.get(a["trigger"], a["trigger"]), "kind": "alert"}
              for a in alerts[:5]]
        if not ms:
            ms = [{"date": _iso(flag_t), "label": "High risk score", "kind": "alert"}]
        add("Flagged", flag_t, plan_t or flag_t, "done", ms)
    if plans and (dx is None or plan_t <= dx):
        ms = [{"date": _iso(_d(p["approved_at"])), "label": f"Care plan approved: {p.get('pathway_name') or p['pathway']}",
               "kind": "plan"} for p in plans]
        add("Approved", plan_t, notif_t or plan_t, "done", ms)
        add("Notified", notif_t, notif_t, "done" if notif_t else "upcoming",
            [{"date": _iso(notif_t), "label": "Patient notified", "kind": "notification"}] if notif_t else [])
        # first contact with care after the plan: a clinic visit, or the endoscopy itself when the patient went straight
        # to the referral (otherwise "Seen" could be dated after the endoscopy it led to)
        seen = next((v for v in visits if v["concept_id"] in (*VISIT_TYPES_SEEN, 5) and _d(v["ts"]) >= plan_t), None)
        add("Seen", _d(seen["ts"]) if seen else None, _d(seen["ts"]) if seen else None,
            "done" if seen else ("missed" if _escalated(tasks, ("FOLLOWUP_VISIT", "RESULT_DISCUSSED", "ONCOLOGY_INTAKE"))
                                 else "upcoming"),
            [{"date": _iso(_d(seen["ts"])), "label": seen.get("label") or "Clinic visit", "kind": "visit"}] if seen else [])
    since = plan_t or flag_t
    if flag_t and pre:
        e_after = next((e for e in endos if since is None or _d(e["ts"]) >= since), None)
        endo_task = [t for t in tasks if t["type"] == "ENDOSCOPY"]
        if e_after:
            add("Endoscopy", _d(e_after["ts"]), _d(e_after["ts"]), "done",
                [{"date": _iso(_d(e_after["ts"])), "label": f"Endoscopy: {endo_imp.get(e_after.get('encounter_id')) or 'done'}",
                  "kind": "procedure"}])
        elif endo_task:
            st = "missed" if _escalated(endo_task, ("ENDOSCOPY",)) else "current"
            due = _d(endo_task[0].get("due_at"))
            add("Endoscopy", _d(endo_task[0].get("opens_at")), due, st,
                [{"date": _iso(due), "label": "Endoscopy due", "kind": "task"}])
        elif dx is None:
            add("Endoscopy", None, None, "upcoming")
    # ---------------------------------------------------------------- diagnosis and treatment
    recovery = None
    if dx is not None and dx <= now:
        if not (flag_t and pre):
            e_dx = [e for e in endos if _d(e["ts"]) <= dx + dt.timedelta(days=1)]
            if e_dx:
                e = e_dx[-1]
                add("Endoscopy", _d(e["ts"]), _d(e["ts"]), "done",
                    [{"date": _iso(_d(e["ts"])), "label": f"Endoscopy: {endo_imp.get(e.get('encounter_id')) or 'done'}",
                      "kind": "procedure"}])
        stage = (tumour or {}).get("stage_group")
        add("Diagnosis", dx, dx, "done",
            [{"date": _iso(dx), "label": f"Diagnosis confirmed{f' (stage {stage})' if stage and stage != 'Unknown' else ''}",
              "kind": "diagnosis"}])
        intents = [r for r in treatment if r["kind"] == "INTENT"]
        staging_ev = [e for e in events if e["event_type"] == "STAGING"]
        st_t = _d(staging_ev[0]["ts"]) if staging_ev else (_d(intents[0]["date"]) if intents else None)
        intent = (intents[-1]["value"] if intents else None) or (tumour or {}).get("treatment_intent")
        if st_t:
            ms = [{"date": _iso(st_t), "label": f"Staging: {staging_ev[0].get('label') or 'recorded'}" if staging_ev else "Staging recorded",
                   "kind": "procedure"}]
            if intent:
                ms.append({"date": _iso(st_t), "label": f"Treatment intent: {intent}", "kind": "plan"})
            add("Staging", st_t, st_t, "done", ms)
        surg = [r for r in treatment if r["kind"] == "GASTRECTOMY" and (r.get("value_coded") == 7000 or r.get("value") == "Yes")]
        cycles = [r for r in treatment if r["kind"] == "CHEMO_CYCLE"]
        regimen = next((r["value"] for r in reversed(treatment) if r["kind"] == "CHEMO_REGIMEN"), None)
        chemo_drugs = sorted({_d(e["ts"]).date() for e in events if e["event_type"] == "DRUG" and e["concept_id"] in (6014, 6015)
                              and _d(e["ts"]) >= dx - dt.timedelta(days=7)})
        chemo_done = len(cycles) if cycles else len(chemo_drugs)
        chemo_planned = REGIMEN_CYCLES.get(regimen, 0) if regimen else (0 if not chemo_done else max(chemo_done, 6))
        tx_dates = [_d(r["date"]) for r in surg + cycles] + [dt.datetime.combine(d, dt.time()) for d in chemo_drugs]
        palliative = (intent or "").lower() in ("palliative", "best supportive care")
        tx_start = min(tx_dates) if tx_dates else None
        tx_end = max(tx_dates) if tx_dates else None
        ongoing = chemo_planned and chemo_done < chemo_planned and tx_end and (now - tx_end).days < 60 and not death
        if tx_start:
            ms = [{"date": _iso(_d(r["date"])), "label": "Gastrectomy", "kind": "treatment"} for r in surg]
            ms += [{"date": _iso(_d(r["date"])), "label": f"Chemotherapy cycle {r.get('value') or ''}".strip(), "kind": "treatment"}
                   for r in cycles]
            if not cycles and chemo_drugs:
                ms.append({"date": chemo_drugs[0].isoformat(), "label": f"Chemotherapy started ({regimen or 'regimen'})",
                           "kind": "treatment"})
            add("Treatment", tx_start, None if ongoing else tx_end, "current" if ongoing else None, ms[:20])
        recur = next((r for r in reversed(treatment) if r["kind"] == "RECURRENCE" and r.get("value_coded") in (7221, 7222)), None)
        anchor = tx_end or st_t or dx
        followups = [v for v in visits if v["concept_id"] in (3, 7) and _d(v["ts"]) > anchor]
        if palliative or (recur and not surg):
            pal_ms = [{"date": _iso(_d(v["ts"])), "label": "Comfort and pain review", "kind": "visit"} for v in followups[-6:]]
            add("Palliative", st_t or dx, death, None, pal_ms)
        elif not ongoing and (surg or tx_end):
            rec_end = anchor + dt.timedelta(days=91)
            surv_end = max(dx + dt.timedelta(days=3 * 365), rec_end)
            add("Recovery", anchor, rec_end, None,
                [{"date": _iso(_d(v["ts"])), "label": "Follow-up visit", "kind": "visit"} for v in followups
                 if _d(v["ts"]) <= rec_end][:4])
            add("Surveillance", rec_end, surv_end, None,
                [{"date": _iso(_d(v["ts"])), "label": "Follow-up visit", "kind": "visit"} for v in followups
                 if rec_end < _d(v["ts"]) <= surv_end][-8:] +
                ([{"date": _iso(_d(recur["date"])), "label": f"Recurrence: {recur.get('value')}", "kind": "diagnosis"}] if recur else []))
            add("Survivorship", surv_end, dx + dt.timedelta(days=5 * 365), None,
                [{"date": _iso(_d(v["ts"])), "label": "Follow-up visit", "kind": "visit"} for v in followups
                 if _d(v["ts"]) > surv_end][-6:])
        recovery = _recovery(patient, events, treatment, ecog or [], tasks, dx, intent, bool(surg), chemo_done, chemo_planned,
                             recur, now, anchor)
    if death:
        add("Deceased", death, death, "done", [{"date": _iso(death), "label": "Died", "kind": "death"}])
        for p in phases:
            if p["status"] in ("current", "upcoming") and p["phase"] != "Deceased":
                p["status"] = "done" if p["status"] == "current" else p["status"]
        phases = [p for p in phases if not (p["status"] == "upcoming" and p["phase"] not in ("Deceased",))]
    # phases ending in the future after a cut-off are trimmed of 'upcoming' duplicates; keep the canonical order
    phases.sort(key=lambda p: PHASES.index(p["phase"]))
    return {"phases": phases, "recovery": recovery}


def _escalated(tasks: list[dict], types: tuple[str, ...]) -> bool:
    return any(t["type"] in types and (t.get("status") == "ESCALATED" or t.get("result") == "MISSED"
                                        or t.get("status") == "DECLINED") for t in tasks)


def _series(events: list[dict], et: str, cid: int, since: dt.datetime | None) -> list[dict]:
    return [{"date": _iso(_d(e["ts"])), "value": e["value_num"]} for e in events
            if e["event_type"] == et and e["concept_id"] == cid and e.get("value_num") is not None
            and (since is None or _d(e["ts"]) >= since)]


def _recovery(patient, events, treatment, ecog, tasks, dx, intent, gastrectomy, chemo_done, chemo_planned, recur, now,
              anchor) -> dict:
    since = dx - dt.timedelta(days=90)
    weight = _series(events, "VITAL", 3000, since)
    base = None
    pre = [w for w in weight if _d(w["date"]) <= (anchor or dx)]
    if pre:
        base = pre[-1]["value"]
    elif weight:
        base = weight[0]["value"]
    last = weight[-1]["value"] if weight else None
    hb = _series(events, "LAB", 3100, since)
    b12 = _series(events, "LAB", 3125, since)
    alb = _series(events, "LAB", 3107, since)
    ecog_s = [{"date": _iso(_d(r["date"])), "value": r["value"]} for r in ecog if r.get("value") is not None]
    year_ago = now - dt.timedelta(days=365)
    missed = sum(1 for t in tasks if (t.get("result") == "MISSED" or t.get("status") == "ESCALATED")
                 and _d(t.get("due_at")) and _d(t["due_at"]) >= year_ago)
    if not tasks:  # no care plan: count long gaps between follow-up visits in the last year (synthetic proxy)
        fu = [_d(v["ts"]) for v in events if v["event_type"] == "VISIT" and v["concept_id"] in (3, 7)
              and anchor and _d(v["ts"]) >= max(anchor, year_ago)]
        if fu and not patient.get("dead"):
            gaps = [(b - a).days for a, b in zip(fu, fu[1:])] + [(now - fu[-1]).days]
            missed = sum(max(0, g // 120) for g in gaps)
    open_due = sorted(_d(t["due_at"]) for t in tasks if t.get("status") in ("SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED")
                      and t["type"] in ("FOLLOWUP_VISIT", "PAIN_REVIEW", "ONCOLOGY_INTAKE", "CHEMO_CYCLE", "B12_CHECK",
                                        "B12_INJECTION", "NUTRITION_REVIEW", "SURVEILLANCE_IMAGING"))
    nxt = open_due[0] if open_due else None
    if nxt is None and not patient.get("dead") and dx and now < dx + dt.timedelta(days=5 * 365):
        last_fu = max((_d(v["ts"]) for v in events if v["event_type"] == "VISIT" and v["concept_id"] in (3, 7)), default=None)
        step = 91 if now < dx + dt.timedelta(days=3 * 365) else 182
        if last_fu:
            nxt = last_fu + dt.timedelta(days=step)
    return {"as_of": _iso(now), "dx_date": _iso(dx), "intent": intent, "gastrectomy": gastrectomy,
            "weight_base": base, "weight_last": last,
            "weight_change_pct": round(100 * (last - base) / base, 1) if base and last else None,
            "hb_last": hb[-1]["value"] if hb else None, "b12_last": b12[-1]["value"] if b12 else None,
            "albumin_last": alb[-1]["value"] if alb else None, "ecog_last": ecog_s[-1]["value"] if ecog_s else None,
            "chemo_done": chemo_done, "chemo_planned": chemo_planned, "missed_visits_12m": missed,
            "recurrence": (recur or {}).get("value"), "next_visit_due": _iso(nxt),
            "series": {"weight": weight, "hb": hb, "b12": b12, "albumin": alb, "ecog": ecog_s}}


def for_patient_app(journey: dict) -> dict:
    """Patient-friendly copy: calm labels, no diagnosis words, no stage, no internal codes."""
    from .messages import forbidden_hits
    phases = []
    for p in journey.get("phases", []):
        label = PATIENT_LABELS.get(p["phase"])
        if label is None:
            continue
        ms = [{"date": m["date"], "label": _friendly(m), "kind": m["kind"]} for m in p.get("milestones", [])
              if m["kind"] in ("visit", "procedure", "treatment", "task", "notification", "plan")]
        ms = [m for m in ms if m["label"] and not forbidden_hits(m["label"])]
        phases.append({"phase": p["phase"], "label": label, "start": p["start"], "end": p["end"], "status": p["status"],
                       "milestones": ms})
    rec = journey.get("recovery") or None
    out_rec = None
    if rec:
        # accepts both the pt_recovery row (next_visit_due, chemo_done, ...) and the API shape (next_visit, chemo{...})
        chemo = rec.get("chemo") or {}
        out_rec = {"next_visit": rec.get("next_visit_due", rec.get("next_visit")),
                   "treatment_cycles": {"done": rec.get("chemo_done", chemo.get("done")),
                                        "planned": rec.get("chemo_planned", chemo.get("planned"))},
                   "weight": (rec.get("series") or {}).get("weight", [])[-12:],
                   "missed_visits": rec.get("missed_visits_12m", rec.get("missed_visits"))}
    return {"phases": phases, "recovery": out_rec}


def _friendly(m: dict) -> str | None:
    lab = m.get("label") or ""
    if m["kind"] == "plan":
        return "Your care plan was agreed" if lab.startswith("Care plan") else None
    if m["kind"] == "procedure":
        return "Stomach check-up" if lab.lower().startswith("endoscopy") else "Scan or test"
    if m["kind"] == "treatment":
        return "Operation" if "Gastrectomy" in lab else "Treatment cycle"
    if m["kind"] == "notification":
        return "Message from your care team"
    if m["kind"] == "task":
        return "Stomach check-up due"
    return "Clinic visit" if m["kind"] == "visit" else None
