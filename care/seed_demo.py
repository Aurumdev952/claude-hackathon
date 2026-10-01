"""Seed realistic demo care plans so the doctor, ministry and patient views have data before anyone clicks.

`PYTHONPATH=. uv run python -m care.seed_demo [--dry-run]`

Picks the two facilities with the most alerts and diagnosed patients and approves about 8 plans across all six
pathways for HIGH-risk, alert and diagnosed patients. Each plan is approved a few weeks back in sim time, then
reconciled to the current sim time against the serve DB, so the demo shows reminders, completed steps (with real EMR
evidence) and overdue escalations. Idempotent: plans carry the note marker "[demo]" and the script does nothing when
they already exist. Output names patients by display id only.
"""
from __future__ import annotations

import argparse
import datetime as dt

from . import engine
from .store import get_store, iso, set_clock, sim_now, to_dt

MARKER = "[demo]"
# pathway -> days before the current sim time that the plan was approved
BACKDATE = {"ENDOSCOPY_REFERRAL": 12, "HP_TEST_AND_TREAT": 40, "ANAEMIA_WORKUP": 26, "ONCOLOGY_TREATMENT": 30,
            "SURVIVORSHIP": 200, "PALLIATIVE_SUPPORT": 45}


def _candidates(db: engine.DB, fac: int, now: dt.datetime) -> list[tuple[str, int, str | None]]:
    """(pathway, patient_id, alert_id) picks for one facility, best first per pathway."""
    out = []
    alerts = db.rows("""SELECT a.alert_id, a.patient_id, a."trigger" FROM pt_alerts a JOIN pt_patient_facility f USING (patient_id)
                        JOIN pt_patient p USING (patient_id)
                        LEFT JOIN pt_risk r USING (patient_id)
                        WHERE f.facility_id = ? AND NOT p.dead ORDER BY r.ensemble_prob DESC NULLS LAST""", [fac]) \
        if db.has("pt_alerts") else []
    by_trig: dict[str, list] = {}
    for a in alerts:
        by_trig.setdefault(a["trigger"], []).append(a)
    endo = (by_trig.get("RISK_BAND_HIGH") or []) + (by_trig.get("ALARM_NO_SCOPE_90D") or [])
    if endo:
        out.append(("ENDOSCOPY_REFERRAL", endo[0]["patient_id"], endo[0]["alert_id"]))
    elif db.has("pt_risk"):
        r = db.one("""SELECT r.patient_id FROM pt_risk r JOIN pt_patient_facility f USING (patient_id) WHERE f.facility_id = ?
                      ORDER BY r.ensemble_prob DESC LIMIT 1""", [fac])
        if r:
            out.append(("ENDOSCOPY_REFERRAL", r["patient_id"], None))
    if by_trig.get("HB_DROP"):
        out.append(("ANAEMIA_WORKUP", by_trig["HB_DROP"][0]["patient_id"], by_trig["HB_DROP"][0]["alert_id"]))
    elif db.has("pt_features"):  # no HB_DROP alert here: the steepest recent haemoglobin fall at this facility
        taken = {pid for _, pid, _ in out}
        for r in db.rows("""SELECT x.patient_id FROM pt_features x JOIN pt_patient_facility f USING (patient_id)
                            WHERE f.facility_id = ? AND x.hb_drop_12m >= 0.5 ORDER BY x.hb_drop_12m DESC LIMIT 5""", [fac]):
            if r["patient_id"] not in taken:
                out.append(("ANAEMIA_WORKUP", r["patient_id"], None))
                break
    for a in by_trig.get("HP_POS_UNTREATED") or []:
        if a["patient_id"] not in {pid for _, pid, _ in out}:
            out.append(("HP_TEST_AND_TREAT", a["patient_id"], a["alert_id"]))
            break
    dx = db.rows("""SELECT p.patient_id, p.dx_date, t.treatment_intent FROM pt_patient p JOIN pt_patient_facility f USING (patient_id)
                    LEFT JOIN pt_tumour t USING (patient_id)
                    WHERE f.facility_id = ? AND p.is_case AND NOT p.dead AND p.dx_date IS NOT NULL
                    ORDER BY p.dx_date DESC""", [fac])
    used = {pid for _, pid, _ in out}

    def pick(pred):
        for r in dx:
            if r["patient_id"] not in used and pred(r):
                used.add(r["patient_id"])
                return r["patient_id"]
        return None

    def age_days(r):
        d = r["dx_date"]
        d = d if isinstance(d, dt.date) else dt.date.fromisoformat(str(d)[:10])
        return (now.date() - d).days

    onc = pick(lambda r: age_days(r) <= 400)
    if onc:
        out.append(("ONCOLOGY_TREATMENT", onc, None))
    surv = pick(lambda r: (r.get("treatment_intent") or "").lower().startswith("curative") and age_days(r) >= 180)
    if surv:
        out.append(("SURVIVORSHIP", surv, None))
    pal = pick(lambda r: (r.get("treatment_intent") or "").lower() in ("palliative", "best supportive care"))
    if pal:
        out.append(("PALLIATIVE_SUPPORT", pal, None))
    return out


def seed(target: int = 8, dry_run: bool = False, log=print) -> list[dict]:
    store = get_store()
    existing = store.rows("SELECT id, display_id, pathway, facility_id, status FROM care_plans WHERE note LIKE ?",
                          [f"%{MARKER}%"])
    if existing:
        log(f"demo plans already present ({len(existing)}): nothing to do")
        return existing
    db = engine.DB()
    now = to_dt(sim_now())
    facs = db.rows("""SELECT f.facility_id, count(DISTINCT a.alert_id) AS n_alerts, count(DISTINCT CASE WHEN p.is_case AND NOT p.dead
                             THEN p.patient_id END) AS n_cases
                      FROM pt_patient_facility f JOIN pt_patient p USING (patient_id) JOIN core_dim_location l ON l.location_id = f.facility_id
                      LEFT JOIN pt_alerts a ON a.patient_id = f.patient_id
                      WHERE l.facility_type IN ('DISTRICT', 'PROVINCIAL', 'REFERRAL')
                      GROUP BY 1 ORDER BY n_alerts + 2 * n_cases DESC LIMIT 2""")
    picks: list[tuple[int, str, int, str | None]] = []
    for f in facs:
        for pw, pid, aid in _candidates(db, int(f["facility_id"]), now):
            if not any(p[2] == pid for p in picks):
                picks.append((int(f["facility_id"]), pw, int(pid), aid))
    # spread across pathways first, then fill up to `target`
    order, seen = [], set()
    for p in picks:
        if p[1] not in seen:
            order.append(p)
            seen.add(p[1])
    order += [p for p in picks if p not in order]
    order = order[:target]
    if dry_run:
        for fac, pw, pid, aid in order:
            log(f"would seed {pw:20s} facility={fac} patient={engine._patient(db, pid)['display_id']}")
        return []
    made = []
    try:
        for fac, pw, pid, aid in order:
            approved = now - dt.timedelta(days=BACKDATE.get(pw, 14))
            set_clock(lambda a=approved: iso(a))
            try:
                r = engine.create_plan(pid, fac, pw, alert_id=aid, note=f"Approved from the follow-up queue {MARKER}",
                                       actor="doctor")
            except engine.CareError as e:
                log(f"skip {pw} for patient {pid}: {e.code}")
                continue
            made.append(r["plan"])
    finally:
        set_clock(None)
    if made:
        start = min(to_dt(p["approved_at"]) for p in made)
        summary = engine.reconcile(iso(start), iso(now))
        log(f"reconciled to {iso(now)}: {summary}")
    out = store.rows(f"SELECT id, display_id, pathway, facility_id, status FROM care_plans WHERE note LIKE ? ORDER BY facility_id, pathway",
                     [f"%{MARKER}%"])
    for p in out:
        log(f"  {p['id']}  {p['display_id']:14s} {p['pathway']:20s} facility={p['facility_id']} {p['status']}")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    seed(a.target, a.dry_run)
