"""Care world (v3 plan §1c): how synthetic patients react to open care tasks, one sim day at a time.

`step(t0, t1)` reads open `care_tasks`, their plans and delivered notifications from `data/analytics/care.sqlite`
(read-only, contract §4.1 schema; nothing happens when the file or tables are missing). For each open task and each
day in (t0, t1] it draws completion from a logistic adherence model (`config/care_world.yaml`): distance from the
patient's home health centre to the task facility, age, sex, urban home, past attendance (serve DB visits in the last
year), task urgency, overdue weeks, delivered notification channels (APP < SMS < CHW), reminders, and a deterministic
per-person engagement draw. Random numbers are keyed by (seed, task, day): same seed + same sim time -> same outcomes.

A completed task becomes real EMR rows through `care.emr_rows.EMRBuilder` (care id range), valued from the latent truth:

| Task | Rows |
|---|---|
| ENDOSCOPY | `generator.intervention.resimulate_from_endoscopy` (latent cancer -> earlier diagnosis, re-simulated course, supersede; else normal/gastritis/IM + rapid urease from latent H. pylori) |
| HP_TEST, HP_TEST_OF_CURE | LAB encounter, H. pylori order + stool antigen (latent infection; a completed eradication course clears it with p 0.85) |
| HP_TREATMENT / IRON_COURSE | OPD encounter with the drug orders |
| HB_RECHECK | LAB encounter, FBC order + Hb from the latent trajectory (cancer bleeding, recovery after treatment) |
| B12_CHECK / B12_INJECTION | LAB encounter + B12 (post-gastrectomy depletion) / RETURN encounter + cyanocobalamin |
| FOLLOWUP_VISIT, RESULT_DISCUSSED, NUTRITION_REVIEW, PAIN_REVIEW | RETURN encounter with weight (+ ECOG, albumin, morphine where relevant) |
| CHW_VISIT | encounter 17 at the home health centre (NOTIFIED = CHW, TASK_OUTCOME = done) |
| CHEMO_CYCLE | RETURN encounter at the oncology site with obs 5063 (cycle number) and drugs, only when the patient's own (re-)simulated course does not already schedule cycles |

Course-driven tasks (PATHOLOGY_REVIEW, ONCOLOGY_INTAKE, STAGING_CT, MDT_PLAN, SURGERY, SURVEILLANCE_IMAGING) get their
evidence from the replayed or re-simulated trajectory, not from here. Tasks already evidenced by rows replayed in this
tick are skipped. `step` returns `{"rows": {table: n}, "outcomes": [...], "summary": {...}}`; each outcome is
`{task_id, plan_id, patient_id, type, status: completed|declined, day, date, result, evidence?}` for `care.engine`.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import random
import sqlite3
from collections import Counter

import polars as pl

from shared import config
from shared.concepts import C

OPEN = ("SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED")
PLAN_OPEN = ("ACTIVE", "ESCALATED")
ACTED = {"ENDOSCOPY", "HP_TEST", "HP_TEST_OF_CURE", "HP_TREATMENT", "HB_RECHECK", "IRON_COURSE", "B12_CHECK",
         "B12_INJECTION", "FOLLOWUP_VISIT", "RESULT_DISCUSSED", "NUTRITION_REVIEW", "PAIN_REVIEW", "CHW_VISIT",
         "CHEMO_CYCLE"}
EPOCH = dt.datetime(1970, 1, 1)
# evidence kinds (mirrors care/evidence.py RULES; used to skip tasks the replayed rows already satisfy)
EVIDENCE = {"ENDOSCOPY": ("enc", (5,)), "HP_TEST": ("obs", (3120, 3121, 3122, 5006)),
            "HP_TEST_OF_CURE": ("obs", (3120, 3121, 3122, 5006)), "HB_RECHECK": ("obs", (3100,)),
            "B12_CHECK": ("obs", (3125,)), "FOLLOWUP_VISIT": ("enc", (3, 7)), "RESULT_DISCUSSED": ("enc", (3, 7)),
            "PAIN_REVIEW": ("enc", (3, 7)), "NUTRITION_REVIEW": ("obs", (3000, 3107)), "CHW_VISIT": ("enc", (17,)),
            "CHEMO_CYCLE": ("obs", (5063,)), "HP_TREATMENT": ("drug", (6001, 6003, 6004)), "IRON_COURSE": ("drug", (6005,)),
            "B12_INJECTION": ("drug", (6017,))}


def _cfg() -> dict:
    return config.load_yaml("care_world.yaml")


def _day(t: dt.datetime) -> int:
    return (t.date() - EPOCH.date()).days


def _parse(s) -> dt.datetime | None:
    if s is None or s == "":
        return None
    if isinstance(s, dt.datetime):
        return s
    return dt.datetime.fromisoformat(str(s).replace("Z", "")[:19])


def _rng(seed: int, *key) -> random.Random:
    return random.Random("|".join(str(k) for k in (seed, *key)))


def _expit(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _km(a: dict | None, b: dict | None) -> float | None:
    if not a or not b or a.get("lat") is None or b.get("lat") is None:
        return None
    la1, lo1, la2, lo2 = map(math.radians, (float(a["lat"]), float(a["lon"]), float(b["lat"]), float(b["lon"])))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


# ----------------------------------------------------------------------------------------------- inputs
def read_care_state(t1: dt.datetime, path=None) -> tuple[list[dict], dict[str, dict], dict[str, list[dict]], dict]:
    """(open tasks, plans by id, delivered notifications by task id, completed tasks by patient) from care.sqlite,
    read-only. Empty when the file or the tables are missing."""
    path = path or (config.ANALYTICS_DIR / "care.sqlite")
    if not path.exists():
        return [], {}, {}, {}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not {"care_tasks", "care_plans"} <= names:
            return [], {}, {}, {}
        plans = {r["id"]: dict(r) for r in con.execute(
            f"SELECT * FROM care_plans WHERE status IN ({','.join('?' * len(PLAN_OPEN))})", PLAN_OPEN)}
        tasks = [dict(r) for r in con.execute(
            f"SELECT * FROM care_tasks WHERE status IN ({','.join('?' * len(OPEN))}) ORDER BY id", OPEN)
            if r["plan_id"] in plans and (_parse(r["opens_at"]) or EPOCH) <= t1]
        notes: dict[str, list[dict]] = {}
        if "notifications" in names and tasks:
            for r in con.execute("SELECT * FROM notifications WHERE task_id IS NOT NULL"):
                notes.setdefault(r["task_id"], []).append(dict(r))
        done: dict[int, list[dict]] = {}
        pids = sorted({t["patient_id"] for t in tasks})
        if pids:
            for r in con.execute(f"SELECT patient_id, type, completed_at FROM care_tasks WHERE status = 'COMPLETED' "
                                 f"AND patient_id IN ({','.join('?' * len(pids))})", pids):
                done.setdefault(r["patient_id"], []).append(dict(r))
        return tasks, plans, notes, done
    finally:
        con.close()


def past_visits(pids: list[int], t1: dt.datetime) -> dict[int, int]:
    """Visit days in the last 365 days per patient from the serve DB (pt_timeline); {} when unavailable."""
    if not pids:
        return {}
    try:
        import duckdb
        cur = json.load(open(config.ANALYTICS_DIR / "current.json"))
        con = duckdb.connect(str(config.ANALYTICS_DIR / cur["file"]), read_only=True)
        try:
            rows = con.execute(f"""SELECT patient_id, count(DISTINCT CAST(ts AS DATE)) FROM pt_timeline
                                   WHERE event_type = 'VISIT' AND ts > ? AND ts <= ?
                                   AND patient_id IN ({','.join(str(int(p)) for p in pids)}) GROUP BY 1""",
                               [t1 - dt.timedelta(days=365), t1]).fetchall()
        finally:
            con.close()
        return {int(a): int(b) for a, b in rows}
    except Exception:  # noqa: BLE001 - no serve DB yet: attendance term is 0
        return {}


def replay_facts(rows: dict[str, pl.DataFrame] | None) -> dict[int, list[tuple]]:
    """(kind, code, day) facts per patient from rows replayed this tick."""
    out: dict[int, list[tuple]] = {}
    if not rows:
        return out
    enc = rows.get("encounter")
    if enc is not None and enc.height:
        for pid, et, ts in enc.select("patient_id", "encounter_type", "encounter_datetime").iter_rows():
            out.setdefault(int(pid), []).append(("enc", int(et), _day(ts)))
    obs = rows.get("obs")
    if obs is not None and obs.height:
        codes = {c for k, cs in EVIDENCE.values() if k == "obs" for c in cs}
        for pid, cid, ts in obs.filter(pl.col("concept_id").is_in(list(codes))).select(
                "person_id", "concept_id", "obs_datetime").iter_rows():
            out.setdefault(int(pid), []).append(("obs", int(cid), _day(ts)))
    orders, drug = rows.get("orders"), rows.get("drug_order")
    if orders is not None and drug is not None and orders.height and drug.height:
        for pid, cid, ts in orders.join(drug.select("order_id"), on="order_id").select(
                "patient_id", "concept_id", "date_activated").iter_rows():
            out.setdefault(int(pid), []).append(("drug", int(cid), _day(ts)))
    return out


# ----------------------------------------------------------------------------------------------- the world
class World:
    def __init__(self, t0: dt.datetime, t1: dt.datetime, adapter, seed: int, log=print):
        from care.emr_rows import EMRBuilder
        from generator import intervention as iv
        self.iv, self.t0, self.t1, self.adapter, self.seed, self.log = iv, t0, t1, adapter, seed, log
        self.cfg = _cfg()
        self.persons, self.cases, _, self.ctx = iv.latent_tables()
        self.b = EMRBuilder(t0, adapter=adapter)
        self.counts: Counter = Counter()
        self._pat: dict[int, tuple] = {}
        self.resim = set(iv.interventions(adapter).filter(pl.col("resimulated"))["patient_id"].to_list())

    # -- patient context
    def patient(self, pid: int):
        if pid not in self._pat:
            pr, case = self.iv.latent_person(pid), self.iv.latent_case(pid)
            self._pat[pid] = (self.iv.rebuild_patient(pr, case, pid) if pr else None, case, pr)
        return self._pat[pid]

    def engagement(self, pid: int) -> float:
        return _rng(self.seed, "engage", pid).gauss(0, float(self.cfg.get("engagement_sd", 0.7)))

    def facility(self, loc) -> dict | None:
        return self.ctx.by_id.get(int(loc)) if loc is not None else None

    def target(self, task: dict, plan: dict, p, day: int) -> int:
        tt = task["type"]
        home = p.home_at(day) if p else plan.get("facility_id")
        if tt == "CHW_VISIT":
            return int(home)
        if tt in ("CHEMO_CYCLE",) and p:
            return self.ctx.oncology_site(p.district_at(day))
        loc = plan.get("target_facility_id") or plan.get("facility_id") or home
        if tt == "ENDOSCOPY":
            if loc is None or not self.ctx.has_endoscopy(int(loc), day):
                loc = self.ctx.endoscopy_site(p.district_at(day) if p else "KGL-NYR", day)[0]
        return int(loc)

    # -- adherence
    def p_day(self, task: dict, plan: dict, p, day: int, notes: list[dict], visits: int) -> float:
        cfg, beta = self.cfg, self.cfg["beta"]
        x = float(cfg["base_logit"].get(task["type"], -3.0))
        loc = self.target(task, plan, p, day)
        if task["type"] == "CHW_VISIT":
            km = float(cfg.get("chw_distance_km", 3))
        else:
            km = _km(self.facility(p.home_at(day)) if p else None, self.facility(loc)) or 10.0
        x += beta["distance_per_10km"] * min(km, 150) / 10
        if p:
            age = p.age(day)
            x += beta["age_70_plus"] if age >= 70 else (beta["age_under_40"] if age < 40 else 0.0)
            x += beta["male"] if p.male else 0.0
            x += beta["urban"] if p.district_at(day).startswith("KGL") else 0.0
        x += beta["past_visit"] * min(visits, 8)
        due = _parse(task.get("due_at"))
        if due is not None and day > _day(due):
            x += max(-0.4, beta["overdue_per_week"] * (day - _day(due)) / 7)
        chans = {n["channel"] for n in notes
                 if _day(_parse(n.get("delivered_sim") or n.get("created_sim")) or self.t1) <= day}
        x += sum(float(beta["channel"].get(c, 0.0)) for c in chans)
        x += beta["reminder"] * min(int(task.get("reminders") or 0), 4)
        x += beta["urgent"] if task["type"] in cfg.get("urgent_types", []) else 0.0
        x += self.engagement(int(task["patient_id"]))
        return _expit(x)

    # -- outcomes
    def course_has_chemo(self, pid: int, case: dict | None) -> bool:
        return pid in self.resim or bool(case and (case.get("chemo_planned") or 0) > 0)

    def hp_infected(self, pid: int, p, day: int, done: list[dict]) -> bool:
        if p is None or not p.hp or (p.hp_erad_day is not None and day >= p.hp_erad_day):
            return False
        for d in done:
            if d["type"] == "HP_TREATMENT" and _parse(d["completed_at"]) and _day(_parse(d["completed_at"])) + 14 <= day:
                if _rng(self.seed, "erad", pid).random() < float(self.cfg["hp"]["eradication_prob"]):
                    return False
        return True

    def act(self, task: dict, plan: dict, p, case, day: int, done: list[dict]) -> dict:
        """Write the rows for a completed task; returns the outcome (result + evidence)."""
        b, tt, pid = self.b, task["type"], int(task["patient_id"])
        r = _rng(self.seed, "act", task["id"], day)
        loc = self.target(task, plan, p, day)
        when = EPOCH + dt.timedelta(days=day, minutes=450 + int(r.random() * 540))
        out = {"result": "DONE"}
        if tt == "ENDOSCOPY":
            anaemic = (plan.get("trigger") or "") == "HB_DROP"
            alarm = (plan.get("trigger") or "") == "ALARM_NO_SCOPE_90D"
            rows, upd = self.iv.resimulate_from_endoscopy(pid, day, loc, seed=_rng(self.seed, "endo", task["id"]).getrandbits(31),
                                                          sim_time=self.t0, adapter=self.adapter, anaemic=anaemic, alarm=alarm)
            res = self.iv.commit(rows, upd, self.t1, adapter=self.adapter, tick=f"care_world endoscopy {task['id']}")
            for t, n in res["written"].items():
                self.counts[t] += n
            if upd.get("resimulated"):
                self.resim.add(pid)
            out = {"result": "CANCER_FOUND" if upd.get("cancer_found") else upd.get("finding", "NORMAL"),
                   "stage": upd.get("stage"), "original_stage": upd.get("original_stage"),
                   "evidence": {"table": "encounter", "id": upd.get("endoscopy_encounter_id"), "date": when.isoformat()}}
            return out
        etype = {"HP_TEST": 4, "HP_TEST_OF_CURE": 4, "HB_RECHECK": 4, "B12_CHECK": 4, "HP_TREATMENT": 2,
                 "IRON_COURSE": 2, "CHW_VISIT": 17}.get(tt, 3)
        e = b.encounter(pid, when, etype, loc)
        ev = {"table": "encounter", "id": e, "date": when.isoformat()}
        if tt in ("HP_TEST", "HP_TEST_OF_CURE"):
            o = b.order(e, C.ORD_HP)
            inf = self.hp_infected(pid, p, day, done)
            hp = self.cfg["hp"]
            pos = r.random() < (hp["test_sensitivity"] if inf else hp["false_positive"])
            oid = b.obs(e, C.HP_STOOL, coded=C.POS if pos else C.NEG, order=o, at=when + dt.timedelta(hours=2))
            out = {"result": "POSITIVE" if pos else "NEGATIVE",
                   "evidence": {"table": "obs", "id": oid, "concept_id": C.HP_STOOL, "value": C.POS if pos else C.NEG,
                                "date": when.isoformat()}}
        elif tt == "HP_TREATMENT":
            b.drug(e, C.OMEPRAZOLE, 14, freq="BD")
            b.drug(e, C.AMOX, 14, freq="BD")
            b.drug(e, C.CLARI if r.random() < 0.7 else C.METRO, 14, freq="BD")
        elif tt == "IRON_COURSE":
            b.drug(e, C.IRON, 30, freq="BD")
        elif tt == "HB_RECHECK":
            o = b.order(e, C.ORD_FBC)
            hb = (p.hb(day) if p else 12.5) + r.gauss(0, 0.35)
            oid = b.obs(e, C.HB, num=round(hb, 1), order=o, at=when + dt.timedelta(hours=2))
            low = hb < (13.0 if (p and p.male) else 12.0)
            out = {"result": "LOW" if low else "NORMAL",
                   "evidence": {"table": "obs", "id": oid, "concept_id": C.HB, "value": round(hb, 1), "date": when.isoformat()}}
        elif tt == "B12_CHECK":
            o = b.order(e, C.ORD_B12)
            b12 = self.b12(case, day, r)
            oid = b.obs(e, C.B12, num=round(b12), order=o, at=when + dt.timedelta(hours=3))
            out = {"result": "LOW" if b12 < 200 else "NORMAL",
                   "evidence": {"table": "obs", "id": oid, "concept_id": C.B12, "value": round(b12), "date": when.isoformat()}}
        elif tt == "B12_INJECTION":
            b.drug(e, C.CYANOCOBALAMIN, 1, qty=1.0)
        elif tt == "CHW_VISIT":
            b.coded(e, C.NOTIFIED, C.CH_CHW)
            b.coded(e, C.TASK_OUTCOME, C.OUTCOME_DONE)
            b.text(e, C.CARE_TASK, "CHW_VISIT")
            if p:
                b.num(e, C.WEIGHT, p.weight(day) + r.gauss(0, 0.5))
        elif tt == "CHEMO_CYCLE":
            k = int(task.get("occurrence") or task.get("seq") or 1)
            b.num(e, C.CHEMO_CYCLE, float(k), 0)
            b.coded(e, C.CHEMO, int(case.get("regimen") or 7211) if case else 7211)
            b.drug(e, C.OXALIPLATIN, 1)
            b.drug(e, C.CAPECITABINE, 14, freq="BD")
        else:  # FOLLOWUP_VISIT, RESULT_DISCUSSED, NUTRITION_REVIEW, PAIN_REVIEW
            if p:
                b.num(e, C.WEIGHT, p.weight(day) + r.gauss(0, 0.35))
            if case and case.get("dx_day") is not None and case["dx_day"] <= day:
                b.num(e, C.ECOG, float(min(4, max(0, {"I": 0, "II": 1, "III": 1, "IV": 2}.get(case.get("stage"), 1)
                                                  + (1 if r.random() < 0.2 else 0)))), 0)
            if tt == "NUTRITION_REVIEW":
                b.num(e, C.ALB, min(5.0, max(2.0, r.gauss(3.7, 0.4))))
            if tt == "PAIN_REVIEW" and case:
                b.drug(e, C.MORPHINE, 30, freq="QID")
        return {**out, "evidence": out.get("evidence", ev)}

    def b12(self, case: dict | None, day: int, r: random.Random) -> float:
        if case and case.get("gastrectomy") and case.get("surgery_day") is not None and case["surgery_day"] <= day:
            k = 0.045 if case.get("gastrectomy_type") == "total" else 0.014
            return 430 * math.exp(-k * (day - case["surgery_day"]) / 30.44) * r.uniform(0.85, 1.15)
        return r.lognormvariate(math.log(420), 0.25)


def step(t0: dt.datetime, t1: dt.datetime, *, adapter=None, seed: int | None = None, log=print,
         replayed: dict | None = None, care_db=None) -> dict:
    """One sim window (t0, t1]: completions for open care tasks, written to the EMR. See the module docstring."""
    tasks, plans, notes, done = read_care_state(t1, care_db)
    if not tasks:
        return {"rows": {}, "outcomes": [], "summary": {"open_tasks": 0}}
    from care import emr
    adapter = adapter or emr.get_adapter()
    if seed is None:
        seed = int(config.generator_cfg().get("seed", 42)) + int(_cfg().get("seed_offset", 913))
    w = World(t0, t1, adapter, seed, log)
    visits = past_visits(sorted({int(t["patient_id"]) for t in tasks}), t1)
    facts = replay_facts(replayed)
    outcomes: list[dict] = []
    summary = Counter(open_tasks=len(tasks))
    d0, d1 = _day(t0) + 1, _day(t1)
    for task in tasks:
        tt, pid = task["type"], int(task["patient_id"])
        if tt not in ACTED:
            continue
        p, case, _ = w.patient(pid)
        if p is None:
            summary["no_latent_person"] += 1
            continue
        if tt == "CHEMO_CYCLE" and w.course_has_chemo(pid, case):
            continue  # cycles come from the patient's own (re-)simulated course
        opens = _day(_parse(task["opens_at"]) or t0)
        kind, codes = EVIDENCE[tt]
        if any(k == kind and c in codes and d >= opens for k, c, d in facts.get(pid, [])):
            summary["evidenced_by_replay"] += 1
            continue
        if p.death <= d1 and p.death < 10**6 and p.death < max(d0, opens):
            continue  # died before the task could be done (the engine closes the plan on the death record)
        plan = plans[task["plan_id"]]
        tnotes = notes.get(task["id"], [])
        dec = float(w.cfg["decline_prob"].get(tt, w.cfg["decline_prob"]["default"]))
        if tnotes and _rng(seed, "decline", task["id"]).random() < dec:
            outcomes.append({"task_id": task["id"], "plan_id": task["plan_id"], "patient_id": pid, "type": tt,
                             "status": "declined", "day": d0, "date": (EPOCH + dt.timedelta(days=d0)).date().isoformat()})
            summary["declined"] += 1
            continue
        for day in range(max(d0, opens), d1 + 1):
            if p.death <= day:
                break
            if _rng(seed, task["id"], day).random() < w.p_day(task, plan, p, day, tnotes, visits.get(pid, 0)):
                res = w.act(task, plan, p, case, day, done.get(pid, []))
                outcomes.append({"task_id": task["id"], "plan_id": task["plan_id"], "patient_id": pid, "type": tt,
                                 "status": "completed", "day": day,
                                 "date": (EPOCH + dt.timedelta(days=day)).date().isoformat(), **res})
                summary[f"completed_{tt}"] += 1
                break
    counts = adapter.write(w.b.frames(), tick=f"care_world {t1.isoformat()}") if len(w.b) else {}
    for t, n in w.counts.items():
        counts[t] = counts.get(t, 0) + n
    log(f"  care world: {len(tasks)} open tasks -> {sum(1 for o in outcomes if o['status'] == 'completed')} completed, "
        f"{summary.get('declined', 0)} declined; rows {dict((k, v) for k, v in counts.items() if v)}")
    return {"rows": {k: int(v) for k, v in counts.items() if v}, "outcomes": outcomes, "summary": dict(summary)}
