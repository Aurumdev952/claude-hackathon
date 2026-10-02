"""Care coordination engine (docs/contracts/v3-loop.md §4.1, plan §2c).

A doctor approves a pathway for a patient (`create_plan`). The engine writes the plan and its first tasks to
`care.sqlite`, records a CARE_COORDINATION encounter with the referral order in the EMR, marks the source alert
REFERRED and queues the first patient messages. Every sim tick `reconcile(t0, t1, con)` closes tasks that have EMR
evidence, runs the reminder / escalation ladder, spawns the next pathway steps and closes finished plans.

Logs and events carry display ids only. Notification bodies never contain names or diagnosis words.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from collections import defaultdict
from typing import Any

from shared.concepts import C

from . import evidence, messages, pathways
from .emr_bridge import ENC_CARE, ENC_CHW, ENC_PATIENT, Rows, adapter, commit_all  # noqa: F401
from .store import get_store, iso, sim_now, to_dt

TERMINAL = ("COMPLETED", "CANCELLED", "DECLINED")
# pathways whose primary step is an endoscopy (anaemia work-up only once it escalates to one): the only care outcomes that
# can verify a cancer label (ml/feedback.py). Other pathways leave recommendation_outcomes.cancer_found NULL.
SCREENING = ("ENDOSCOPY_REFERRAL", "ANAEMIA_WORKUP")
NEG_CONFIRM_DAYS = 60  # an endoscopy is a verified negative once this many days pass without a diagnosis
OPEN = ("SCHEDULED", "DUE", "NOTIFIED", "OVERDUE", "ESCALATED")
PLAN_OPEN = ("ACTIVE", "ESCALATED")
CH_CONCEPT = {"APP": C.CH_APP, "SMS": C.CH_SMS, "CHW": C.CH_CHW}
AGE_BANDS = [(0, 40, "<40"), (40, 50, "40-49"), (50, 60, "50-59"), (60, 70, "60-69"), (70, 200, "70+")]


class CareError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ------------------------------------------------------------------------------------------------ DB access
class DB:
    """Uniform read access to the serve DB (api.deps.SERVE) or a DuckDB connection (work or serve)."""

    def __init__(self, con=None):
        self.serve = None
        self.con = con
        if con is None:
            try:
                from api.deps import SERVE
                if SERVE.ready:
                    self.serve = SERVE
            except Exception:  # noqa: BLE001
                self.serve = None
            if self.serve is None:
                self.con = _open_serve()
        elif hasattr(con, "has_table") and hasattr(con, "rows"):
            self.serve, self.con = con, None
        self._tables: dict[str, bool] = {}

    def rows(self, sql: str, params: list | None = None) -> list[dict]:
        if self.serve is not None:
            return self.serve.rows(sql, params)
        if self.con is None:
            return []
        r = self.con.execute(sql, params or [])
        cols = [d[0] for d in r.description]
        return [dict(zip(cols, row)) for row in r.fetchall()]

    def one(self, sql: str, params: list | None = None) -> dict | None:
        r = self.rows(sql, params)
        return r[0] if r else None

    def has(self, table: str) -> bool:
        if table not in self._tables:
            try:
                self._tables[table] = bool(self.one("SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?",
                                                    [table])["n"])
            except Exception:  # noqa: BLE001
                self._tables[table] = False
        return self._tables[table]

    @property
    def duck(self):
        """A raw DuckDB connection/cursor (for evidence.fetch_facts)."""
        if self.serve is not None:
            return self.serve.connection()
        return self.con


def _open_serve():
    import duckdb

    from shared.config import ANALYTICS_DIR
    try:
        cur = json.load(open(ANALYTICS_DIR / "current.json"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return duckdb.connect(str(ANALYTICS_DIR / f"serve_{cur['active']}.duckdb"), read_only=True)


def _patient(db: DB, pid: int) -> dict:
    if db.has("pt_patient"):
        p = db.one("""SELECT patient_id, display_id, given_name, family_name, sex, age, birthdate, district_code,
                             home_facility_id, is_case, dx_date, dead, death_date FROM pt_patient WHERE patient_id = ?""", [pid])
    else:
        p = db.one("""SELECT patient_id, NULL AS display_id, NULL AS given_name, NULL AS family_name, sex,
                             NULL AS age, birthdate, district_code, home_facility_id, FALSE AS is_case, NULL AS dx_date,
                             dead, death_date FROM core_dim_patient WHERE patient_id = ?""", [pid])
    if not p:
        raise CareError(404, "NOT_FOUND", "Patient not found")
    p["display_id"] = p.get("display_id") or f"PT-{pid}"
    return p


def _locations(db: DB) -> dict[int, dict]:
    if not db.has("core_dim_location"):
        return {}
    return {int(r["location_id"]): r for r in db.rows(
        "SELECT location_id, name, facility_type, district_code, lat, lon, endoscopy_from_date FROM core_dim_location")}


def _km(a: dict | None, b: dict | None) -> float | None:
    if not a or not b or a.get("lat") is None or b.get("lat") is None:
        return None
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return round(6371 * 2 * math.asin(math.sqrt(h)), 1)


def _nearest(locs: dict[int, dict], origin: int | None, pred) -> tuple[int | None, float | None]:
    o = locs.get(int(origin)) if origin is not None else None
    best, best_d = None, None
    for lid, l in locs.items():
        if not pred(l):
            continue
        d = _km(o, l)
        if d is not None and (best_d is None or d < best_d):
            best, best_d = lid, d
    return best, best_d


def _endo_ok(now: dt.datetime):
    def pred(l):
        d = l.get("endoscopy_from_date")
        if d is None:
            return False
        d = d if isinstance(d, dt.date) else dt.date.fromisoformat(str(d)[:10])
        return d <= now.date()
    return pred


def _age_band(age) -> str | None:
    if age is None:
        return None
    for lo, hi, lab in AGE_BANDS:
        if lo <= age < hi:
            return lab
    return None


def _clinical_facts(db: DB, pt: dict, trigger: str | None, now: dt.datetime, locs: dict) -> dict:
    """Conditions used by pathway `when` rules and the outcome record (stored as plan.context)."""
    pid = int(pt["patient_id"])
    f: dict[str, Any] = {"alarm": trigger == "ALARM_NO_SCOPE_90D"}
    if db.has("pt_tumour"):
        t = db.one("SELECT stage_group, treatment_intent FROM pt_tumour WHERE patient_id = ?", [pid])
        if t:
            f["stage_group"] = t.get("stage_group")
            f["advanced"] = str(t.get("stage_group") or "").upper().replace("STAGE ", "") in ("III", "IIIA", "IIIB", "IIIC", "IV")
            f["intent"] = t.get("treatment_intent")
    if db.has("pt_recovery"):
        r = db.one("SELECT gastrectomy FROM pt_recovery WHERE patient_id = ?", [pid])
        if r and r.get("gastrectomy"):
            f["gastrectomy"] = True
    if db.has("pt_timeline"):
        hb = db.one("""SELECT value_num FROM pt_timeline WHERE patient_id = ? AND event_type = 'LAB' AND concept_id = 3100
                       AND ts <= ? ORDER BY ts DESC LIMIT 1""", [pid, now])
        if hb and hb.get("value_num") is not None:
            f["hb_baseline"] = float(hb["value_num"])
    # total gastrectomy is not coded separately in the EMR: treat any gastrectomy as needing B12 (synthetic default)
    f["total_gastrectomy"] = bool(f.get("gastrectomy"))
    home = pt.get("home_facility_id")
    _, d = _nearest(locs, home, _endo_ok(now))
    f["distance_km"] = d
    return f


def _default_target(pw: dict, facility_id: int, pt: dict, locs: dict, now: dt.datetime) -> int:
    origin = pt.get("home_facility_id") or facility_id
    if pw.get("target") == "endoscopy":
        if facility_id in locs and _endo_ok(now)(locs[facility_id]):
            return facility_id
        t, _ = _nearest(locs, origin, _endo_ok(now))
        return t or facility_id
    if pw.get("target") == "oncology":
        t, _ = _nearest(locs, origin, lambda l: l.get("facility_type") == "REFERRAL")
        return t or facility_id
    return facility_id


def _facility_name(locs: dict, fid) -> str:
    l = locs.get(int(fid)) if fid is not None else None
    return l["name"] if l else "your health centre"


def _new_id(prefix: str, *key, taken=None) -> str:
    """Deterministic id: prefix + 8 hex of a hash of `key` (same actions -> same ids -> the same care-world draws, which
    are keyed by task). `taken(id) -> bool` reports ids already in use; a collision re-hashes with a salt."""
    for salt in range(1000):
        h = hashlib.blake2b("|".join(str(k) for k in (*key, salt or "")).encode(), digest_size=8).hexdigest()[:8].upper()
        out = f"{prefix}-{h}"
        if taken is None or not taken(out):
            return out
    raise RuntimeError(f"could not allocate a unique {prefix} id")


def _taken(table: str, extra: set | None = None):
    store = get_store()
    return lambda i: (extra is not None and i in extra) or store.one(f"SELECT 1 AS x FROM {table} WHERE id = ?", [i]) is not None


def _wall() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------------------------------------ task building
def _task_rows(plan_id: str, pid: int, pw_id: str, specs: list[dict], anchor: dt.datetime, now: dt.datetime,
               start_seq: int, due_override: dt.datetime | None = None, *, persist: bool = False) -> list[dict]:
    out = []
    ids: set = set()
    for i, s in enumerate(specs):
        opens = anchor + dt.timedelta(days=s["opens"])
        due = anchor + dt.timedelta(days=s["due"])
        if due_override is not None and i == 0:
            due = due_override
            opens = min(opens, due)
        tid = _new_id("CT", plan_id, start_seq + i, taken=_taken("care_tasks", ids) if persist else None)
        ids.add(tid)
        out.append({"id": tid, "plan_id": plan_id, "patient_id": pid, "seq": start_seq + i, "type": s["type"],
                    "title": s["title"], "status": "DUE" if opens <= now else "SCHEDULED", "opens_at": iso(opens),
                    "due_at": iso(due), "completed_at": None, "evidence": None, "result": None, "reminders": 0,
                    "last_reminder_sim": None, "escalation_level": 0, "created_sim": iso(now),
                    "occurrence": s.get("occurrence")})
    return out


def preview(patient_id: int, pathway: str, *, due_override: str | None = None, channels: list[str] | None = None,
            facility_id: int | None = None, target_facility_id: int | None = None, alert_id: str | None = None,
            con=None) -> dict:
    """Render the tasks and the first patient messages without writing anything."""
    ctx = _prepare(patient_id, facility_id, pathway, alert_id=alert_id, due_override=due_override, channels=channels,
                   target_facility_id=target_facility_id, con=con)
    tasks = _task_rows("CP-PREVIEW", patient_id, pathway, ctx["specs"], ctx["now"], ctx["now"], 1, ctx["due_override"])
    msgs = []
    first = next((t for t in tasks if t["status"] == "DUE" and pathways.patient_facing(pathway, t["type"])), None)
    if first:
        for ch in ctx["channels"]:
            m = messages.render(pathway, first["type"], "approved", ch, task_title=first["title"], facility=ctx["target_name"],
                                date=first["due_at"], display_id=ctx["pt"]["display_id"])
            if ch == "APP":
                m["greeting"] = messages.greeting(ctx["pt"].get("given_name"))
            msgs.append({"channel": ch, **m})
    return {"pathway": pathway, "target_facility": {"id": ctx["target"], "name": ctx["target_name"]},
            "tasks": [_public_task(t) for t in tasks], "messages": msgs}


def _prepare(patient_id, facility_id, pathway, *, alert_id, due_override, channels, target_facility_id, con) -> dict:
    try:
        pw = pathways.pathway(pathway)
    except KeyError:
        raise CareError(400, "INVALID_PATHWAY", f"Unknown pathway {pathway!r}") from None
    db = DB(con)
    pt = _patient(db, int(patient_id))
    now = to_dt(sim_now())
    trigger = None
    if alert_id:
        a = db.one("SELECT patient_id, \"trigger\" FROM pt_alerts WHERE alert_id = ?", [alert_id]) if db.has("pt_alerts") else None
        if not a or int(a["patient_id"]) != int(patient_id):
            raise CareError(400, "INVALID_ALERT", "alert_id does not belong to this patient")
        trigger = a["trigger"]
    chans = [c.upper() for c in (channels if channels is not None else pw.get("default_channels", ["APP", "SMS"]))]
    bad = [c for c in chans if c not in pathways.CHANNELS]
    if bad:
        raise CareError(400, "INVALID_CHANNEL", f"Unknown channel(s) {bad}; use APP, SMS, CHW")
    locs = _locations(db)
    facility_id = int(facility_id if facility_id is not None else (pt.get("home_facility_id") or 0))
    if target_facility_id is not None and locs and int(target_facility_id) not in locs:
        raise CareError(400, "INVALID_FACILITY", "Unknown target facility")
    facts = _clinical_facts(db, pt, trigger, now, locs)
    target = int(target_facility_id) if target_facility_id is not None else _default_target(pw, facility_id, pt, locs, now)
    dov = None
    if due_override:
        try:
            dov = to_dt(due_override)
        except ValueError:
            raise CareError(400, "INVALID_DATE", "due_override must be an ISO date") from None
        if dov < now:
            raise CareError(400, "INVALID_DATE", "due_override is in the past")
    specs = pathways.start_tasks(pathway, trigger=trigger, facts=facts)
    return {"pw": pw, "db": db, "pt": pt, "now": now, "trigger": trigger, "channels": chans, "locs": locs,
            "facility_id": facility_id, "facts": facts, "target": target, "target_name": _facility_name(locs, target),
            "due_override": dov, "specs": specs}


# ------------------------------------------------------------------------------------------------ create
def create_plan(patient_id: int, facility_id: int, pathway: str, *, alert_id: str | None = None,
                due_override: str | None = None, channels: list[str] | None = None,
                target_facility_id: int | None = None, note: str | None = None, actor: str = "doctor",
                con=None, set_alert_status: bool = True) -> dict:
    ctx = _prepare(patient_id, facility_id, pathway, alert_id=alert_id, due_override=due_override, channels=channels,
                   target_facility_id=target_facility_id, con=con)
    store = get_store()
    pid, now, db, pt = int(patient_id), ctx["now"], ctx["db"], ctx["pt"]
    risk = db.one("SELECT ensemble_prob, risk_band FROM pt_risk WHERE patient_id = ?", [pid]) if db.has("pt_risk") else None
    model = db.one("SELECT model_id FROM ml_model_registry WHERE is_active AND tier = 2 ORDER BY trained_at DESC LIMIT 1") \
        if db.has("ml_model_registry") else None
    facts = ctx["facts"]
    # One write transaction (BEGIN IMMEDIATE, serialised across the API and the simulator): the open-plan check, the EMR
    # write and the inserts. A double submit therefore gets 409 before any EMR row is written; the partial unique index
    # ux_plans_open (care/store.py) is the last guard.
    with store.tx() as c:
        if store.one(f"SELECT id FROM care_plans WHERE patient_id = ? AND pathway = ? AND status IN {PLAN_OPEN}", [pid, pathway]):
            raise CareError(409, "PLAN_EXISTS", "This patient already has an open plan on this pathway")
        n_prior = store.one("SELECT count(*) AS n FROM care_plans WHERE patient_id = ?", [pid])["n"]
        plan_id = _new_id("CP", pid, pathway, iso(now), n_prior, taken=_taken("care_plans"))
        tasks = _task_rows(plan_id, pid, pathway, ctx["specs"], now, now, 1, ctx["due_override"], persist=True)
        # EMR: CARE_COORDINATION encounter with pathway, tasks, channels and the referral order
        rows = Rows(pid, ctx["facility_id"] or ctx["target"], now, ENC_CARE, now)
        order_id = rows.order(int(ctx["pw"]["order"]))
        rows.obs(C.CARE_PATHWAY, coded=int(ctx["pw"]["concept"]), order_id=order_id)
        for t in tasks:
            rows.obs(C.CARE_TASK, text=t["type"])
        for ch in ctx["channels"]:
            rows.obs(C.NOTIFIED, coded=CH_CONCEPT[ch])
        rows.commit()
        # propensity (P(outcome verified | features), for IPW) is estimated when the feedback labels are built
        # (ml/feedback.py), from all screening plans; the risk score itself is not a propensity
        plan = {"id": plan_id, "patient_id": pid, "display_id": pt["display_id"], "facility_id": ctx["facility_id"],
                "pathway": pathway, "status": "ACTIVE", "source_alert_id": alert_id, "trigger": ctx["trigger"],
                "approved_by": actor, "approved_at": iso(now), "channels": json.dumps(ctx["channels"]),
                "model_id": (model or {}).get("model_id"),
                "risk_at_approval": _f((risk or {}).get("ensemble_prob")), "band_at_approval": (risk or {}).get("risk_band"),
                "propensity": None,
                "due_override": iso(ctx["due_override"]) if ctx["due_override"] else None, "target_facility_id": ctx["target"],
                "note": note, "emr_encounter_id": rows.encounter_id, "created_sim": iso(now), "closed_sim": None,
                "context": json.dumps({**facts, "district_code": pt.get("district_code"), "sex": pt.get("sex"),
                                       "age_band": _age_band(pt.get("age"))}, default=str)}
        w = _Writer(store, {plan_id: plan}, ctx["locs"])
        store.insert("care_plans", plan, c)
        w.event(plan, None, "PLAN_CREATED", {"pathway": pathway, "channels": ctx["channels"], "alert_id": alert_id,
                                             "emr_encounter_id": rows.encounter_id, "order_id": order_id}, actor, now)
        for t in tasks:
            store.insert("care_tasks", t, c)
            w.event(plan, t, "TASK_CREATED", {"type": t["type"], "due_at": t["due_at"]}, "system", now)
            if t["status"] == "DUE":
                w.opened(plan, t, now, stage="approved")
        w.flush(c)
    if alert_id and set_alert_status:
        try:
            from api import app_state
            app_state.set_alert_status(alert_id, "REFERRED", note or f"Care plan {plan_id} ({pathway})", None, ctx["facility_id"])
        except Exception as e:  # noqa: BLE001
            print(f"care: could not set alert status: {e}")
    _upsert_outcomes([plan_id], db, now)
    out = plan_detail(plan_id)
    return {"plan": out["plan"], "tasks": out["tasks"], "notifications": w.notifications}


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------------------------------------ writer
class _Writer:
    """Collects events, notifications, task updates, outbox messages and EMR rows inside one transaction."""

    def __init__(self, store, plans: dict[str, dict], locs: dict, emr_rows: list | None = None):
        self.store, self.plans, self.locs = store, plans, locs
        self.events: list[dict] = []
        self.notifications: list[dict] = []
        self.outbox: list[dict] = []
        self.emr: list[Rows] = emr_rows if emr_rows is not None else []
        self.task_updates: dict[str, dict] = {}
        self.new_tasks: list[dict] = []
        self.by_plan: dict[str, list[dict]] | None = None  # live task lists (reconcile / patch) that spawns join
        self.fresh: list[dict] = []  # spawned during this pass, still to be checked for evidence
        self.counts = defaultdict(int)
        self.ids: set[str] = set()  # notification ids allocated by this writer (not yet flushed)

    def event(self, plan, task, kind, detail, actor, when):
        self.events.append({"plan_id": plan["id"], "task_id": task["id"] if task else None, "patient_id": plan["patient_id"],
                            "kind": kind, "detail": json.dumps(detail, default=str), "actor": actor, "sim_time": iso(when),
                            "wall_time": _wall(), "created_sim": iso(when)})
        self.outbox.append({"type": "care_update", "facility_id": plan["facility_id"], "patient_id": plan["patient_id"],
                            "plan_id": plan["id"], "task_id": task["id"] if task else None, "kind": kind.lower()})
        if plan.get("target_facility_id") and plan["target_facility_id"] != plan["facility_id"]:
            self.outbox.append({**self.outbox[-1], "facility_id": plan["target_facility_id"]})

    def notify(self, plan, task, stage, channel, when):
        title = task["title"] if task else ""
        target = plan.get("target_facility_id") or plan["facility_id"]
        m = messages.render(plan["pathway"], task["type"] if task else "default", stage, channel, task_title=title,
                            facility=_facility_name(self.locs, target), date=task["due_at"] if task else None,
                            display_id=plan.get("display_id"))
        nid = _new_id("NT", plan["id"], task["id"] if task else "-", channel, stage, iso(when), len(self.notifications),
                      taken=_taken("notifications", self.ids))
        self.ids.add(nid)
        n = {"id": nid, "patient_id": plan["patient_id"], "plan_id": plan["id"], "task_id": task["id"] if task else None,
             "channel": channel, "template_key": m["template_key"], "title": m["title"], "body": m["body"],
             "created_sim": iso(when), "delivered_sim": iso(when), "read_sim": None, "acted_sim": None}
        self.notifications.append(n)
        self.counts["notifications"] += 1
        if channel != "CHW":
            self.outbox.append({"type": "notification", "patient_id": plan["patient_id"],
                                "notification": {k: n[k] for k in ("id", "channel", "title", "body", "created_sim")}})
        self.event(plan, task, "NOTIFIED", {"channel": channel, "stage": stage, "notification_id": n["id"]}, "system", when)
        return n

    def opened(self, plan, task, when, stage="approved"):
        chans = json.loads(plan["channels"]) if isinstance(plan["channels"], str) else plan["channels"]
        if not pathways.patient_facing(plan["pathway"], task["type"]):
            return
        for ch in chans:
            if ch in ("APP", "SMS"):
                self.notify(plan, task, stage, ch, when)
        if "CHW" in chans and stage == "approved" and task["seq"] == 1:
            self.notify(plan, task, "approved", "CHW", when)
        self.update(task, status="NOTIFIED", last_reminder_sim=iso(when))

    def update(self, task, **changes):
        task.update(changes)
        self.task_updates.setdefault(task["id"], {}).update(changes)

    def add_task(self, task):
        self.new_tasks.append(task)

    def flush(self, c):
        for t in self.new_tasks:
            self.store.insert("care_tasks", t, c)
            self.task_updates.pop(t["id"], None)
        for tid, ch in self.task_updates.items():
            self.store.update("care_tasks", tid, ch, c)
        for e in self.events:
            self.store.insert("care_events", e, c)
        for n in self.notifications:
            self.store.insert("notifications", n, c)
        for o in self.outbox:
            self.store.push(o, c)
        self.new_tasks, self.task_updates, self.events, self.outbox = [], {}, [], []


# ------------------------------------------------------------------------------------------------ reconcile
def reconcile(t0, t1, con=None, *, log=print, outcomes: list[dict] | None = None) -> dict:
    """Advance every open plan to sim time t1 using EMR evidence from `con` (work DB or serve DB).

    `outcomes` are the care world's reports for this window (simulator/care_world.py `step()["outcomes"]`): a patient
    who declines a task closes it as DECLINED (with the reason, a care event for the doctor and a TASK_OUTCOME obs).
    Completions still need EMR evidence. The read-modify-write runs inside one BEGIN IMMEDIATE transaction, so a
    concurrent `patch_task` (API process) is never overwritten: it either commits before (and is read here) or waits."""
    store = get_store()
    t1 = to_dt(t1)
    db = DB(con)
    locs = _locations(db)
    summary = {"completed": 0, "overdue": 0, "reminders": 0, "escalations": 0, "new_tasks": 0, "plans_closed": 0,
               "declined": 0}
    plans = {p["id"]: p for p in store.rows(f"SELECT * FROM care_plans WHERE status IN {PLAN_OPEN}")}
    by_plan: dict[str, list[dict]] = defaultdict(list)
    w = _Writer(store, plans, locs)
    if plans:
        _reconcile_open(store, db, locs, t0, t1, outcomes, summary, plans, by_plan, w)
    try:
        commit_all(w.emr, iso(t1))
    except Exception as e:  # noqa: BLE001
        log(f"care: EMR write failed: {e}")
    # outcomes of open plans, plus recently closed screening plans whose label may still change (a diagnosis after the
    # endoscopy, or the 60-day negative confirmation)
    recent = [r["id"] for r in store.rows(
        f"""SELECT id FROM care_plans WHERE status NOT IN {PLAN_OPEN} AND closed_sim >= ?
            AND pathway IN ({','.join('?' * len(SCREENING))})""",
        [iso(t1 - dt.timedelta(days=NEG_CONFIRM_DAYS + 120)), *SCREENING]) if r["id"] not in plans]
    _upsert_outcomes(list(plans) + recent, db, t1)
    summary["reminders"] = w.counts["reminders"]
    summary["notifications"] = w.counts["notifications"]
    summary["overdue"] = sum(1 for p in plans for t in by_plan[p] if t["status"] in ("OVERDUE", "ESCALATED"))
    return summary


def _reconcile_open(store, db: DB, locs: dict, t0, t1: dt.datetime, outcomes, summary: dict, plans: dict, by_plan: dict,
                    w: "_Writer"):
    with store.tx() as c:
        # re-read inside the write transaction: a plan closed in between (patch_task) is no longer reconciled
        fresh = {p["id"]: p for p in store.rows(f"SELECT * FROM care_plans WHERE status IN {PLAN_OPEN}")}
        for k in list(plans):
            if k not in fresh:
                del plans[k]
            else:
                plans[k].update(fresh[k])
        if not plans:
            return
        ph = ",".join("?" * len(plans))
        tasks = store.rows(f"SELECT * FROM care_tasks WHERE plan_id IN ({ph}) ORDER BY due_at, seq", list(plans))
        for t in tasks:
            by_plan[t["plan_id"]].append(t)
        used: dict[str, set] = defaultdict(set)
        for t in tasks:
            if t["evidence"]:
                k = evidence.evidence_key(json.loads(t["evidence"]))
                if k:
                    used[t["plan_id"]].add(k)
        w.by_plan = by_plan
        # deaths close plans
        pids = sorted({p["patient_id"] for p in plans.values()})
        dead = _deaths(db, pids, t1)
        for p in plans.values():
            if p["patient_id"] in dead:
                for t in by_plan[p["id"]]:
                    if t["status"] in OPEN:
                        w.update(t, status="CANCELLED", result="DECEASED")
                p["status"], p["closed_sim"] = "CANCELLED", iso(min(t1, dead[p["patient_id"]]))
                w.event(p, None, "PLAN_CANCELLED", {"reason": "deceased"}, "system", to_dt(p["closed_sim"]))
                summary["plans_closed"] += 1
        # patient declines reported by the care world
        by_id = {t["id"]: t for t in tasks}
        for o in outcomes or []:
            if o.get("status") != "declined":
                continue
            t = by_id.get(o.get("task_id"))
            plan = plans.get(t["plan_id"]) if t else None
            if t is None or plan is None or plan["status"] not in PLAN_OPEN or t["status"] not in OPEN:
                continue
            when = _outcome_time(o, t, t0, t1)
            _ladder(w, plan, t, when, summary)
            _decline(w, plan, t, when, o.get("reason") or "patient declined", "patient", by_plan, source="care_world")
            summary["declined"] += 1
        open_tasks = [t for t in tasks if t["status"] in OPEN and plans[t["plan_id"]]["status"] in PLAN_OPEN]
        since = min((evidence.lower_bound(t) for t in open_tasks), default=t1)
        duck = db.duck
        facts = evidence.fetch_facts(duck, pids, since, t1) if duck is not None and open_tasks else {}

        queue = sorted(open_tasks, key=lambda t: (t["due_at"], t["seq"]))
        for _round in range(200):
            while queue:
                t = queue.pop(0)
                plan = plans[t["plan_id"]]
                if plan["status"] not in PLAN_OPEN or t["status"] in TERMINAL:
                    continue
                f = evidence.find(t, facts.get(plan["patient_id"], []), used[plan["id"]], t1)
                done_at = _dt(f["date"]) if f else None
                _ladder(w, plan, t, min(done_at or t1, _cap(plan, t, t1)), summary)
                if f and done_at <= _cap(plan, t, t1):
                    ctx = json.loads(plan.get("context") or "{}")
                    res = evidence.result_of(t["type"], f, ctx)
                    used[plan["id"]].add(evidence.fact_key(f))
                    _complete(w, plan, t, done_at, evidence.as_evidence(f), res, "system", by_plan)
                    summary["completed"] += 1
                if w.fresh:
                    summary["new_tasks"] += len(w.fresh)
                    queue.extend(w.fresh)
                    w.fresh = []
                    queue.sort(key=lambda x: (x["due_at"], x["seq"]))
            # recurring schedules add occurrences (and catch up missed ones) once the one-off tasks are settled
            for p in plans.values():
                if p["status"] in PLAN_OPEN:
                    _recurring(w, p, by_plan, t1)
            if not w.fresh:
                break
            summary["new_tasks"] += len(w.fresh)
            queue, w.fresh = sorted(w.fresh, key=lambda x: (x["due_at"], x["seq"])), []
        for p in plans.values():
            if p["status"] in PLAN_OPEN:
                _maybe_close(w, p, by_plan[p["id"]], t1, summary)
        for p in plans.values():
            store.update("care_plans", p["id"], {"status": p["status"], "closed_sim": p.get("closed_sim")}, c)
        w.flush(c)


def _outcome_time(o: dict, t: dict, t0, t1: dt.datetime) -> dt.datetime:
    """Sim time of a care-world outcome (it reports a date): noon that day, inside the task window and (t0, t1]."""
    try:
        d = dt.datetime.combine(dt.date.fromisoformat(str(o.get("date"))[:10]), dt.time(12))
    except ValueError:
        d = t1
    lo = max(evidence.lower_bound(t), to_dt(t0) + dt.timedelta(seconds=1)) if t0 is not None else evidence.lower_bound(t)
    return min(max(d, lo), t1)


def _decline(w: "_Writer", plan: dict, t: dict, when: dt.datetime, reason: str, actor: str, by_plan: dict,
             source: str | None = None):
    """Close a task as DECLINED: reason in the evidence, a DECLINED care event (doctor WS update) and the EMR outcome."""
    ev = {"reason": reason}
    if source:
        ev["source"] = source
    w.update(t, status="DECLINED", completed_at=iso(when), result="DECLINED", evidence=json.dumps(ev))
    w.event(plan, t, "DECLINED", {"reason": reason, "type": t["type"], **({"source": source} if source else {})}, actor, when)
    _emr_outcome(w, plan, t, when, C.OUTCOME_DECLINED)
    if plan["status"] == "ESCALATED" and not any(x["status"] == "ESCALATED" for x in by_plan.get(plan["id"], []) if x is not t):
        plan["status"] = "ACTIVE"


def _dt(v) -> dt.datetime:
    return v if isinstance(v, dt.datetime) else to_dt(v)


def _deaths(db: DB, pids: list[int], t1: dt.datetime) -> dict[int, dt.datetime]:
    if not pids:
        return {}
    tbl = "pt_patient" if db.has("pt_patient") else "core_dim_patient" if db.has("core_dim_patient") else None
    if not tbl:
        return {}
    rows = db.rows(f"SELECT patient_id, death_date FROM {tbl} WHERE death_date IS NOT NULL AND patient_id IN "
                   f"({','.join(str(int(p)) for p in pids)})")
    out = {}
    for r in rows:
        d = r["death_date"]
        d = dt.datetime.combine(d, dt.time()) if isinstance(d, dt.date) and not isinstance(d, dt.datetime) else _dt(str(d))
        if d <= t1:
            out[int(r["patient_id"])] = d
    return out


def _ladder(w: _Writer, plan: dict, t: dict, horizon: dt.datetime, summary: dict):
    """Status transitions and the reminder ladder for one task, up to `horizon` (completion time or t1)."""
    opens, due, created = to_dt(t["opens_at"]), to_dt(t["due_at"]), to_dt(t["created_sim"])
    if t["status"] == "SCHEDULED" and opens <= horizon:
        w.update(t, status="DUE")
        w.event(plan, t, "TASK_OPENED", {"type": t["type"]}, "system", max(opens, created))
        w.opened(plan, t, max(opens, created), stage="approved")
    if t["status"] == "SCHEDULED":
        return
    facing = pathways.patient_facing(plan["pathway"], t["type"])
    chans = json.loads(plan["channels"]) if isinstance(plan["channels"], str) else plan["channels"]
    steps = pathways.ladder() if facing else []
    i = int(t["reminders"] or 0)
    while i < len(steps):
        s = steps[i]
        at = due + dt.timedelta(days=s["offset_days"])
        if at > horizon:
            break
        i += 1
        if at < created or at < opens and s["offset_days"] < 0:
            continue  # the step fell before the task existed / opened: the opening message already covered it
        if at > due:
            _mark_overdue(w, plan, t, due, at)
        lvl = s.get("escalation_level")
        if s.get("doctor"):
            w.update(t, status="ESCALATED", escalation_level=3)
            plan["status"] = "ESCALATED"
            w.event(plan, t, "ESCALATED", {"level": 3, "to": "doctor", "days_overdue": s["offset_days"]}, "system", at)
            r = Rows(plan["patient_id"], plan["facility_id"], at, ENC_CARE, at)
            r.obs(C.CARE_TASK, text=t["type"])
            r.obs(C.TASK_OUTCOME, coded=C.OUTCOME_UNREACHED)
            w.emr.append(r)
            summary["escalations"] += 1
            continue
        if s.get("spawn") == "CHW_VISIT":
            has_own_chw = any(x["type"] == "CHW_VISIT" for x in pathways.pathway(plan["pathway"])["tasks"])
            if "CHW" in chans and not has_own_chw:  # palliative care already has monthly CHW home visits
                chw = _spawn_task(w, plan, "CHW_VISIT", at, opens_days=0, due_days=int(s.get("chw_due_days", 7)))
                w.notify(plan, t, "overdue", "CHW", at)
                r = Rows(plan["patient_id"], plan["facility_id"], at, ENC_CARE, at)
                r.order(C.ORD_CHW)
                r.obs(C.NOTIFIED, coded=C.CH_CHW)
                w.emr.append(r)
                w.update(t, escalation_level=max(int(t["escalation_level"] or 0), 2))
                w.event(plan, t, "CHW_ASSIGNED", {"chw_task_id": chw["id"]}, "system", at)
                summary["escalations"] += 1
            for ch in ("APP", "SMS"):
                if ch in chans:
                    w.notify(plan, t, "overdue", ch, at)
            w.update(t, reminders=i, last_reminder_sim=iso(at))
            continue
        sent = False
        for ch in s.get("channels", []):
            if ch in chans and ch != "CHW":
                w.notify(plan, t, s["stage"], ch, at)
                sent = True
        if sent:
            w.counts["reminders"] += 1
            if lvl and "SMS" in chans:
                w.update(t, escalation_level=max(int(t["escalation_level"] or 0), int(lvl)))
            if t["status"] == "DUE":
                w.update(t, status="NOTIFIED")
        w.update(t, reminders=i, last_reminder_sim=iso(at))
    w.update(t, reminders=i)
    if horizon > due:
        _mark_overdue(w, plan, t, due, horizon)


def _cap(plan: dict, t: dict, t1: dt.datetime) -> dt.datetime:
    """A recurring occurrence is only followed until the next occurrence's window opens (then it is MISSED)."""
    if t.get("occurrence") is None:
        return t1
    spec = pathways.task_spec(plan["pathway"], t["type"])
    occ = pathways.occurrences(spec)
    k = int(t["occurrence"]) + 1
    if k >= len(occ):
        return t1
    o, _ = pathways.window(spec, occ[k])
    return min(t1, to_dt(plan["approved_at"]) + dt.timedelta(days=o))


def _mark_overdue(w: _Writer, plan: dict, t: dict, due: dt.datetime, upto: dt.datetime):
    if t["status"] in ("DUE", "NOTIFIED"):
        w.update(t, status="OVERDUE")
        w.event(plan, t, "OVERDUE", {"due_at": t["due_at"]}, "system", min(upto, due + dt.timedelta(days=1)))


def _spawn_task(w: _Writer, plan: dict, ttype: str, anchor: dt.datetime, *, opens_days: int | None = None,
                due_days: int | None = None, occurrence: int | None = None, opens_at=None, due_at=None) -> dict:
    spec = pathways.task_spec(plan["pathway"], ttype)
    o = opens_at or anchor + dt.timedelta(days=opens_days if opens_days is not None else int(spec.get("opens_days", 0)))
    d = due_at or anchor + dt.timedelta(days=due_days if due_days is not None else int(spec.get("due_days", 14)))
    seq = 1 + max([int(x["seq"]) for x in w.store.rows("SELECT seq FROM care_tasks WHERE plan_id = ?", [plan["id"]])] +
                  [int(x["seq"]) for x in w.new_tasks if x["plan_id"] == plan["id"]] + [0])
    tid = _new_id("CT", plan["id"], seq, taken=_taken("care_tasks", {x["id"] for x in w.new_tasks}))
    t = {"id": tid, "plan_id": plan["id"], "patient_id": plan["patient_id"], "seq": seq, "type": ttype,
         "title": spec.get("title", ttype.replace("_", " ").title()), "status": "SCHEDULED", "opens_at": iso(o), "due_at": iso(d),
         "completed_at": None, "evidence": None, "result": None, "reminders": 0, "last_reminder_sim": None,
         "escalation_level": 0, "created_sim": iso(anchor), "occurrence": occurrence}
    w.add_task(t)
    if w.by_plan is not None:
        w.by_plan.setdefault(plan["id"], []).append(t)
    w.fresh.append(t)
    w.event(plan, t, "TASK_CREATED", {"type": ttype, "due_at": t["due_at"]}, "system", anchor)
    return t


def _complete(w: _Writer, plan: dict, t: dict, when: dt.datetime, ev: dict, result: str, actor: str,
              by_plan: dict[str, list[dict]]) -> list[dict]:
    w.update(t, status="COMPLETED", completed_at=iso(when), evidence=json.dumps(ev, default=str), result=result)
    w.event(plan, t, "COMPLETED", {"type": t["type"], "result": result, "evidence": ev}, actor, when)
    if pathways.patient_facing(plan["pathway"], t["type"]):
        chans = json.loads(plan["channels"]) if isinstance(plan["channels"], str) else plan["channels"]
        if "APP" in chans:
            w.notify(plan, t, "completed", "APP", when)
    if plan["status"] == "ESCALATED" and not any(x["status"] == "ESCALATED" for x in by_plan[plan["id"]] if x is not t):
        plan["status"] = "ACTIVE"
    spawned = []
    if t["type"] == "CHW_VISIT" or t.get("occurrence") is not None:
        return spawned
    for nxt in pathways.next_tasks(plan["pathway"], t["type"], result):
        spec = pathways.task_spec(plan["pathway"], nxt)
        n_have = sum(1 for x in by_plan[plan["id"]] if x["type"] == nxt)
        if spec.get("max_spawns") and n_have >= int(spec["max_spawns"]):
            continue
        spawned.append(_spawn_task(w, plan, nxt, when))
    if result == "CANCER_FOUND":
        w.event(plan, t, "NEXT_PATHWAY_SUGGESTED", {"pathway": "ONCOLOGY_TREATMENT"}, "system", when)
    if result in ("CURATIVE",) and plan["pathway"] == "ONCOLOGY_TREATMENT":
        w.event(plan, t, "NEXT_PATHWAY_SUGGESTED", {"pathway": "SURVIVORSHIP", "after": "treatment"}, "system", when)
    if result in ("PALLIATIVE", "BSC"):
        w.event(plan, t, "NEXT_PATHWAY_SUGGESTED", {"pathway": "PALLIATIVE_SUPPORT"}, "system", when)
    return spawned


def _recurring(w: _Writer, plan: dict, by_plan: dict, t1: dt.datetime) -> list[dict]:
    """Keep one open occurrence per recurring task. The next occurrence is scheduled as soon as the current one closes;
    if the next window opens while the current one is still open, the current one is recorded as MISSED."""
    pw = pathways.pathway(plan["pathway"])
    start = to_dt(plan["approved_at"])
    ctx = json.loads(plan.get("context") or "{}")
    end_days = pw.get("end_days")
    out = []
    for spec in pw["tasks"]:
        if not spec.get("repeat") or not pathways.applies(spec, ctx):
            continue
        occ = pathways.occurrences(spec)
        while True:
            have = {int(x["occurrence"]): x for x in by_plan[plan["id"]]
                    if x["type"] == spec["type"] and x.get("occurrence") is not None}
            k = max(have, default=-1)
            if k + 1 >= len(occ) or (end_days and occ[k + 1] > int(end_days)):
                break
            o, d = pathways.window(spec, occ[k + 1])
            opens, due = start + dt.timedelta(days=o), start + dt.timedelta(days=d)
            cur = have.get(k)
            if cur is not None and cur["status"] not in TERMINAL:
                if t1 < opens:
                    break
                w.update(cur, status="CANCELLED", result="MISSED")
                w.event(plan, cur, "MISSED", {"type": cur["type"], "due_at": cur["due_at"]}, "system", opens)
                anchor = opens
            elif cur is not None and cur.get("completed_at"):
                anchor = min(to_dt(cur["completed_at"]), opens)
            else:
                anchor = min(start, opens)
            s = _spawn_task(w, plan, spec["type"], anchor, occurrence=k + 1, opens_at=opens, due_at=due)
            out.append(s)
            if opens > t1:
                break
    return out


def _maybe_close(w: _Writer, plan: dict, tasks: list[dict], t1: dt.datetime, summary: dict):
    pw = pathways.pathway(plan["pathway"])
    start = to_dt(plan["approved_at"])
    if pw.get("end_days") and t1 >= start + dt.timedelta(days=int(pw["end_days"])):
        for t in tasks:
            if t["status"] in OPEN:
                w.update(t, status="CANCELLED", result="PLAN_ENDED")
        plan["status"], plan["closed_sim"] = "COMPLETED", iso(start + dt.timedelta(days=int(pw["end_days"])))
        w.event(plan, None, "PLAN_COMPLETED", {"reason": "schedule finished"}, "system", to_dt(plan["closed_sim"]))
        summary["plans_closed"] += 1
        return
    if any(t["status"] in OPEN for t in tasks):
        return
    if any(s.get("repeat") for s in pw["tasks"]):
        return  # recurring pathways close at end_days
    last = max((to_dt(t["completed_at"]) for t in tasks if t.get("completed_at")), default=t1)
    if any(t["status"] == "DECLINED" for t in tasks) and not any(t["status"] == "COMPLETED" for t in tasks):
        # the patient declined and nothing was done: the plan is cancelled (not a completed pathway)
        plan["status"], plan["closed_sim"] = "CANCELLED", iso(last)
        w.event(plan, None, "PLAN_CANCELLED", {"reason": "declined", "tasks": len(tasks)}, "system", last)
    else:
        plan["status"], plan["closed_sim"] = "COMPLETED", iso(last)
        w.event(plan, None, "PLAN_COMPLETED", {"tasks": len(tasks)}, "system", last)
    summary["plans_closed"] += 1


# ------------------------------------------------------------------------------------------------ outcomes (L3 input)
def _upsert_outcomes(plan_ids: list[str], db: DB, now: dt.datetime):
    store = get_store()
    if not plan_ids:
        return
    ph = ",".join("?" * len(plan_ids))
    plans = store.rows(f"SELECT * FROM care_plans WHERE id IN ({ph})", plan_ids)
    tasks = store.rows(f"SELECT * FROM care_tasks WHERE plan_id IN ({ph}) ORDER BY seq", plan_ids)
    by_plan = defaultdict(list)
    for t in tasks:
        by_plan[t["plan_id"]].append(t)
    pids = sorted({p["patient_id"] for p in plans})
    dx: dict[int, dict] = {}
    if pids and (db.has("core_gc_case") or db.has("pt_patient")):
        ids = ",".join(str(int(p)) for p in pids)
        if db.has("core_gc_case"):
            for r in db.rows(f"SELECT patient_id, dx_date, stage_group FROM core_gc_case WHERE patient_id IN ({ids})"):
                dx[int(r["patient_id"])] = r
    with store.tx() as c:
        for p in plans:
            ts = by_plan[p["id"]]
            if not ts:
                continue
            primary = ts[0]
            ctx = json.loads(p.get("context") or "{}")
            approved = to_dt(p["approved_at"])
            comp = to_dt(primary["completed_at"]) if primary.get("completed_at") else None
            if primary["status"] == "COMPLETED":
                adhered = 1
            elif primary["status"] in ("DECLINED", "ESCALATED") or (primary["status"] == "CANCELLED" and primary["result"] != "DECEASED"):
                adhered = 0
            elif primary["status"] == "OVERDUE" and now > to_dt(primary["due_at"]) + dt.timedelta(days=14):
                adhered = 0
            else:
                adhered = None
            results = [t["result"] for t in ts if t.get("result") and t["status"] == "COMPLETED"]
            cancer, stage = _cancer_found(p, ts, dx.get(p["patient_id"]), approved, now)
            finding = next((r for r in reversed(results) if r not in ("DONE",)), None)
            row = {"plan_id": p["id"], "patient_id": p["patient_id"], "pathway": p["pathway"], "approved_sim": p["approved_at"],
                   "first_completion_sim": iso(comp) if comp else None,
                   "days_to_completion": (comp - approved).days if comp else None, "adhered": adhered,
                   "on_time": (1 if comp and comp <= to_dt(primary["due_at"]) else 0) if adhered is not None else None,
                   "finding": finding, "cancer_found": cancer, "stage_at_dx": stage, "channels": p["channels"],
                   "reminders": sum(int(t["reminders"] or 0) for t in ts),
                   "escalation_level": max(int(t["escalation_level"] or 0) for t in ts),
                   "district_code": ctx.get("district_code"), "distance_km": ctx.get("distance_km"), "sex": ctx.get("sex"),
                   "age_band": ctx.get("age_band"), "risk_at_approval": p["risk_at_approval"], "propensity": p["propensity"],
                   "closed_sim": p["closed_sim"], "created_sim": p["created_sim"]}
            store.insert("recommendation_outcomes", row, c, replace=True)


def _cancer_found(plan: dict, tasks: list[dict], case: dict | None, approved: dt.datetime, now: dt.datetime):
    """(cancer_found, stage_at_dx) of a plan: 1/0 only for a screening pathway with a completed endoscopy, else NULL.

    - not a screening pathway (H. pylori, oncology, survivorship, palliative) or no endoscopy done -> NULL;
    - diagnosed before the plan was approved (the landmark) -> NULL (not a valid screening label);
    - pathology/endoscopy result CANCER_FOUND, or a diagnosis between approval and endoscopy + 60 days -> 1;
    - endoscopy at least 60 days ago and no diagnosis by then -> 0;
    - otherwise (e.g. SUSPICIOUS endoscopy, pathology pending) -> NULL until it is known."""
    if plan["pathway"] not in SCREENING:
        return None, None
    endo = next((t for t in tasks if t["type"] == "ENDOSCOPY" and t["status"] == "COMPLETED" and t.get("completed_at")), None)
    if endo is None:
        return None, None
    e_at = to_dt(endo["completed_at"])
    dd = None
    if case and case.get("dx_date") is not None:
        dd = case["dx_date"]
        dd = dd if isinstance(dd, dt.date) else dt.date.fromisoformat(str(dd)[:10])
        if isinstance(dd, dt.datetime):
            dd = dd.date()
    if dd is not None and dd < approved.date():
        return None, None
    window_end = e_at + dt.timedelta(days=NEG_CONFIRM_DAYS)
    found = any(t.get("result") == "CANCER_FOUND" and t["status"] == "COMPLETED" and t.get("completed_at")
                and to_dt(t["completed_at"]) <= window_end for t in tasks)
    if dd is not None and dd <= window_end.date():
        return 1, (case or {}).get("stage_group")
    if found:
        return 1, None
    if now >= window_end:
        return 0, None
    return None, None


# ------------------------------------------------------------------------------------------------ manual actions
def patch_task(task_id: str, action: str, *, reason: str | None = None, due_at: str | None = None,
               result: str | None = None, actor: str = "doctor", facility_id: int | None = None) -> dict:
    store = get_store()
    action = (action or "").lower()
    if action not in ("complete", "decline", "reschedule"):
        raise CareError(400, "INVALID_ACTION", "action must be complete|decline|reschedule")
    if action == "decline" and not reason:
        raise CareError(400, "REASON_REQUIRED", "Declining a task needs a reason")
    nd = None
    if action == "reschedule":
        if not due_at:
            raise CareError(400, "DUE_REQUIRED", "Rescheduling needs due_at")
        try:
            nd = to_dt(due_at)
        except ValueError:
            raise CareError(400, "INVALID_DATE", "due_at must be an ISO date") from None
    now = to_dt(sim_now())
    db = DB()
    locs = _locations(db)
    # read-modify-write inside one BEGIN IMMEDIATE transaction: a reconcile in the simulator process cannot interleave
    with store.tx() as c:
        t = store.one("SELECT * FROM care_tasks WHERE id = ?", [task_id])
        if not t:
            raise CareError(404, "NOT_FOUND", "Task not found")
        plan = store.one("SELECT * FROM care_plans WHERE id = ?", [t["plan_id"]])
        if facility_id is not None and int(facility_id) not in (plan["facility_id"], plan["target_facility_id"]):
            raise CareError(404, "NOT_FOUND", "Task not found at this facility")
        if t["status"] in TERMINAL:
            raise CareError(409, "TASK_CLOSED", f"Task is already {t['status']}")
        w = _Writer(store, {plan["id"]: plan}, locs)
        all_tasks = store.rows("SELECT * FROM care_tasks WHERE plan_id = ? ORDER BY seq", [plan["id"]])
        by_plan = {plan["id"]: [x if x["id"] != t["id"] else t for x in all_tasks]}
        w.by_plan = by_plan
        if action == "complete":
            ev = {"table": None, "id": None, "manual": True, "by": actor, "reason": reason, "date": iso(now)}
            _complete(w, plan, t, now, ev, (result or "DONE").upper(), actor, by_plan)
            _emr_outcome(w, plan, t, now, C.OUTCOME_DONE)
        elif action == "decline":
            _decline(w, plan, t, now, reason, actor, by_plan)
        else:
            if nd <= now:
                raise CareError(400, "INVALID_DATE", "due_at must be in the future")
            opens = min(to_dt(t["opens_at"]), nd)
            w.update(t, due_at=iso(nd), opens_at=iso(opens), reminders=0, escalation_level=0,
                     status="DUE" if opens <= now else "SCHEDULED")
            w.event(plan, t, "RESCHEDULED", {"due_at": iso(nd), "reason": reason}, actor, now)
            if plan["status"] == "ESCALATED" and not any(x["status"] == "ESCALATED" for x in by_plan[plan["id"]]):
                plan["status"] = "ACTIVE"
        _maybe_close(w, plan, by_plan[plan["id"]], now, {"plans_closed": 0})
        store.update("care_plans", plan["id"], {"status": plan["status"], "closed_sim": plan.get("closed_sim")}, c)
        w.flush(c)
    commit_all(w.emr, iso(now))
    _upsert_outcomes([plan["id"]], db, now)
    return {"task": _public_task(store.one("SELECT * FROM care_tasks WHERE id = ?", [task_id])),
            "plan": plan_detail(plan["id"])["plan"]}


def _emr_outcome(w: _Writer, plan: dict, t: dict, when: dt.datetime, outcome: int):
    r = Rows(plan["patient_id"], plan["facility_id"], when, ENC_CARE, when)
    r.obs(C.CARE_TASK, text=t["type"])
    r.obs(C.TASK_OUTCOME, coded=outcome)
    w.emr.append(r)


# ------------------------------------------------------------------------------------------------ reads
def _public_task(t: dict) -> dict:
    out = dict(t)
    if isinstance(out.get("evidence"), str):
        try:
            out["evidence"] = json.loads(out["evidence"])
        except json.JSONDecodeError:
            pass
    return out


def _public_plan(p: dict) -> dict:
    out = dict(p)
    for k in ("channels", "context"):
        if isinstance(out.get(k), str):
            try:
                out[k] = json.loads(out[k])
            except json.JSONDecodeError:
                pass
    return out


def plan_detail(plan_id: str) -> dict:
    store = get_store()
    p = store.one("SELECT * FROM care_plans WHERE id = ?", [plan_id])
    if not p:
        raise CareError(404, "NOT_FOUND", "Plan not found")
    tasks = store.rows("SELECT * FROM care_tasks WHERE plan_id = ? ORDER BY seq", [plan_id])
    events = store.rows("SELECT * FROM care_events WHERE plan_id = ? ORDER BY id", [plan_id])
    for e in events:
        e["detail"] = json.loads(e["detail"]) if e.get("detail") else None
    return {"plan": _public_plan(p), "tasks": [_public_task(t) for t in tasks], "events": events}


def plans_for(patient_id: int | None = None, *, facility_id: int | None = None, status: str | None = None) -> list[dict]:
    store = get_store()
    where, params = [], []
    if patient_id is not None:
        where.append("patient_id = ?")
        params.append(int(patient_id))
    if facility_id is not None:
        where.append("(facility_id = ? OR target_facility_id = ?)")
        params += [int(facility_id)] * 2
    if status:
        sts = [s.strip().upper() for s in status.split(",")]
        where.append(f"status IN ({','.join('?' * len(sts))})")
        params += sts
    plans = store.rows(f"SELECT id FROM care_plans {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY approved_at DESC",
                       params)
    out = []
    for p in plans:
        d = plan_detail(p["id"])
        out.append({**d["plan"], "tasks": d["tasks"], "events": d["events"]})
    return out


def worklist(facility_id: int, con=None) -> list[dict]:
    store = get_store()
    now = to_dt(sim_now())
    rows = store.rows(f"""SELECT t.*, p.pathway, p.facility_id, p.target_facility_id, p.display_id, p.channels, p.context,
                                 p.status AS plan_status, p.approved_at, p.risk_at_approval
                          FROM care_tasks t JOIN care_plans p ON p.id = t.plan_id
                          WHERE p.status IN {PLAN_OPEN} AND t.status IN ('DUE','NOTIFIED','OVERDUE','ESCALATED')
                            AND (p.facility_id = ? OR p.target_facility_id = ?)""", [facility_id, facility_id])
    if not rows:
        return []
    db = DB(con)
    pids = sorted({r["patient_id"] for r in rows})
    pts = {}
    if db.has("pt_patient"):
        for r in db.rows(f"""SELECT patient_id, display_id, given_name, family_name, age, sex FROM pt_patient
                              WHERE patient_id IN ({','.join(str(int(p)) for p in pids)})"""):
            pts[int(r["patient_id"])] = r
    ctxs = [json.loads(r.get("context") or "{}") for r in rows]
    bases = _model_p([{"task": r, "ctx": c} for r, c in zip(rows, ctxs)])
    out = []
    for r, ctx, base in zip(rows, ctxs, bases):
        overdue = max(0, (now - to_dt(r["due_at"])).days)
        p = p_adhere(r, ctx, overdue, base)
        prio = round((1 - p) * (1 + overdue / 7) * (2.0 if r["status"] == "ESCALATED" else 1.0) *
                     (1.5 if r["status"] == "OVERDUE" else 1.0), 3)
        task = {k: r[k] for k in ("id", "plan_id", "patient_id", "seq", "type", "title", "status", "opens_at", "due_at",
                                  "reminders", "last_reminder_sim", "escalation_level")}
        task["overdue_days"] = overdue
        plan = {"id": r["plan_id"], "pathway": r["pathway"], "status": r["plan_status"], "approved_at": r["approved_at"],
                "facility_id": r["facility_id"], "target_facility_id": r["target_facility_id"]}
        pt = pts.get(int(r["patient_id"]), {"patient_id": r["patient_id"], "display_id": r["display_id"]})
        out.append({"task": task, "plan": plan, "patient": pt, "p_adhere": round(p, 3), "priority": prio})
    out.sort(key=lambda x: (-x["priority"], x["task"]["due_at"]))
    return out


def _suggestion_reason(detail: dict, from_pathway: str | None, task_type: str | None, result: str | None) -> str:
    nxt = detail.get("pathway")
    if nxt == "ONCOLOGY_TREATMENT":
        if from_pathway == "ANAEMIA_WORKUP":
            return "Cancer found during the anaemia work-up"
        return "Cancer found at the referral endoscopy"
    if nxt == "SURVIVORSHIP":
        return "Curative treatment completed"
    if nxt == "PALLIATIVE_SUPPORT":
        return "Best supportive care chosen" if result == "BSC" else "Treatment goal is comfort and symptom control"
    return "Suggested after the previous plan"


def suggestions(facility_id: int | None = None, patient_id: int | None = None, con=None) -> list[dict]:
    """Open next-plan suggestions (NEXT_PATHWAY_SUGGESTED events the doctor has not acted on yet).

    The latest suggestion per patient and pathway stays open until a plan on that pathway is created at or after it (any
    status except CANCELLED); one with an open plan on that pathway is not offered either (a new plan would be a 409).
    Nothing is created automatically: the doctor starts the plan. With `facility_id`, only patients the facility can
    reach (pt_patient_facility link, or a care plan approved at / targeted to it: api.routers.care.check_access)."""
    store = get_store()
    where, params = ["e.kind = 'NEXT_PATHWAY_SUGGESTED'"], []
    if patient_id is not None:
        where.append("e.patient_id = ?")
        params.append(int(patient_id))
    evs = store.rows(f"""SELECT e.id, e.plan_id, e.task_id, e.patient_id, e.detail, e.sim_time, p.pathway AS from_pathway,
                                p.display_id, t.type AS task_type, t.result
                         FROM care_events e JOIN care_plans p ON p.id = e.plan_id LEFT JOIN care_tasks t ON t.id = e.task_id
                         WHERE {' AND '.join(where)} ORDER BY e.sim_time, e.id""", params)
    if not evs:
        return []
    latest: dict[tuple[int, str], dict] = {}
    for e in evs:
        try:
            detail = json.loads(e["detail"] or "{}")
        except json.JSONDecodeError:
            continue
        if not detail.get("pathway"):
            continue
        latest[(int(e["patient_id"]), detail["pathway"])] = {**e, "detail_obj": detail}
    pids = sorted({k[0] for k in latest})
    marks = ",".join("?" * len(pids))
    plans = store.rows(f"SELECT patient_id, pathway, status, approved_at, facility_id, target_facility_id FROM care_plans "
                       f"WHERE patient_id IN ({marks})", pids)
    reach: set[int] | None = None
    db = None
    if facility_id is not None:
        fid = int(facility_id)
        reach = {int(p["patient_id"]) for p in plans if fid in (p["facility_id"], p["target_facility_id"])}
        db = DB(con)
        if db.has("pt_patient_facility"):
            reach |= {int(r["patient_id"]) for r in db.rows(
                f"SELECT DISTINCT patient_id FROM pt_patient_facility WHERE facility_id = ? AND patient_id IN ({marks})",
                [fid, *pids])}
    db = db or DB(con)
    dead: set[int] = set()
    if db.has("pt_patient"):
        dead = {int(r["patient_id"]) for r in db.rows(
            f"SELECT patient_id FROM pt_patient WHERE coalesce(dead, FALSE) AND patient_id IN ({marks})", pids)}
    names = {k: v["name"] for k, v in pathways.pathways().items()}
    out = []
    for (pid, pw), e in latest.items():
        if reach is not None and pid not in reach:
            continue
        if pid in dead:
            continue
        since = to_dt(e["sim_time"])
        acted = any(int(p["patient_id"]) == pid and p["pathway"] == pw and p["status"] != "CANCELLED" and
                    (to_dt(p["approved_at"]) >= since or p["status"] in PLAN_OPEN) for p in plans)
        if acted:
            continue
        out.append({"patient_id": pid, "display_id": e["display_id"], "pathway": pw, "pathway_name": names.get(pw, pw),
                    "reason": _suggestion_reason(e["detail_obj"], e["from_pathway"], e["task_type"], e["result"]),
                    "since": e["sim_time"], "from_plan_id": e["plan_id"]})
    out.sort(key=lambda s: s["since"], reverse=True)
    return out


def p_adhere(task: dict, ctx: dict, overdue_days: int, base: float | None = None) -> float:
    """P(the patient completes this task): the adherence model's on-time probability at approval (ml.adherence, L3;
    a config prior until enough outcomes exist), lowered for days overdue and escalation steps already used."""
    if base is None:
        base = _model_p([{"task": task, "ctx": ctx}])[0]
    z = math.log(base / (1 - base)) - 0.08 * overdue_days - 0.35 * int(task.get("escalation_level") or 0)
    return 1 / (1 + math.exp(-z))


def _model_p(items: list[dict]) -> list[float]:
    rows = [{"pathway": it["task"].get("pathway"), "channels": it["task"].get("channels"), "distance_km": it["ctx"].get("distance_km"),
             "sex": it["ctx"].get("sex"), "age_band": it["ctx"].get("age_band"),
             "risk_at_approval": it["task"].get("risk_at_approval")} for it in items]
    try:
        from ml import adherence  # track L3
        out = [float(min(0.99, max(0.01, v))) for v in adherence.predict_p_adhere(rows)]
        if len(out) == len(rows):
            return out
    except Exception:  # noqa: BLE001 - fall back to the built-in prior
        pass
    res = []
    for r in rows:
        z = 1.0 - 0.025 * float(r["distance_km"] or 15) + (0.2 if r["sex"] == "F" else 0.0) - \
            (0.3 if r["age_band"] == "70+" else 0.0) + (0.3 if "CHW" in str(r["channels"]) else 0.0)
        res.append(1 / (1 + math.exp(-z)))
    return res


def notifications_for(patient_id: int, *, channels: tuple[str, ...] = ("APP", "SMS")) -> list[dict]:
    ph = ",".join("?" * len(channels))
    return get_store().rows(f"""SELECT * FROM notifications WHERE patient_id = ? AND channel IN ({ph})
                                ORDER BY created_sim DESC, id""", [int(patient_id), *channels])


def mark_notification(patient_id: int, notification_id: str, field: str) -> dict:
    assert field in ("read_sim", "acted_sim")
    store = get_store()
    n = store.one("SELECT * FROM notifications WHERE id = ?", [notification_id])
    if not n:
        raise CareError(404, "NOT_FOUND", "Notification not found")
    if int(n["patient_id"]) != int(patient_id):
        raise CareError(403, "FORBIDDEN", "This notification belongs to another patient")
    now = sim_now()
    ch = {field: n[field] or now}
    if field == "acted_sim" and not n["read_sim"]:
        ch["read_sim"] = now
    store.update("notifications", notification_id, ch)
    if field == "acted_sim" and n.get("plan_id"):
        plan = store.one("SELECT * FROM care_plans WHERE id = ?", [n["plan_id"]])
        if plan:
            w = _Writer(store, {plan["id"]: plan}, {})
            w.event(plan, {"id": n["task_id"]} if n["task_id"] else None, "PATIENT_ACTED",
                    {"notification_id": notification_id}, "patient", to_dt(now))
            with store.tx() as c:
                w.flush(c)
    return store.one("SELECT * FROM notifications WHERE id = ?", [notification_id])


def _home(patient_id: int, db: DB) -> tuple[dict, int]:
    pt = _patient(db, patient_id)
    store = get_store()
    p = store.one(f"SELECT facility_id FROM care_plans WHERE patient_id = ? ORDER BY approved_at DESC LIMIT 1", [patient_id])
    fac = pt.get("home_facility_id") or (p or {}).get("facility_id") or 0
    return pt, int(fac)


def _report(patient_id: int, kind: str, payload: dict, rows: Rows | None, now: dt.datetime, task_id: str | None = None):
    store = get_store()
    n = store.one("SELECT count(*) AS n FROM patient_reports WHERE patient_id = ?", [int(patient_id)])["n"]
    rid = _new_id("PR", int(patient_id), kind, iso(now), n, taken=_taken("patient_reports"))
    rep = {"id": rid, "patient_id": int(patient_id), "kind": kind, "payload": json.dumps(payload),
           "emr_encounter_id": rows.encounter_id if rows else None, "created_sim": iso(now)}
    if task_id:
        plan = store.one("SELECT p.* FROM care_plans p JOIN care_tasks t ON t.plan_id = p.id WHERE t.id = ?", [task_id])
    else:
        plan = store.one(f"""SELECT * FROM care_plans WHERE patient_id = ? AND status IN {PLAN_OPEN}
                             ORDER BY approved_at DESC LIMIT 1""", [int(patient_id)])
    w = _Writer(store, {plan["id"]: plan} if plan else {}, {})
    if plan:
        w.event(plan, {"id": task_id} if task_id else None,
                {"CHECKIN": "CHECKIN", "DOSE": "DOSE", "CONFIRM": "PATIENT_CONFIRMED"}[kind], payload, "patient", now)
    with store.tx() as c:
        store.insert("patient_reports", rep, c)
        w.flush(c)
    return {**rep, "payload": payload}


def record_checkin(patient_id: int, payload: dict, con=None) -> dict:
    vals = {}
    for k in ("appetite", "pain", "energy"):
        v = payload.get(k)
        if v is None or not isinstance(v, (int, float)) or not 0 <= v <= 10:
            raise CareError(400, "INVALID_CHECKIN", f"{k} must be a number 0-10")
        vals[k] = float(v)
    dumping = payload.get("dumping")
    if dumping in (0, 1) and not isinstance(dumping, bool):
        dumping = bool(dumping)
    if not isinstance(dumping, bool):
        raise CareError(400, "INVALID_CHECKIN", "dumping must be true or false")
    wkg = payload.get("weight_kg")
    if wkg is not None and (not isinstance(wkg, (int, float)) or not 20 <= wkg <= 250):
        raise CareError(400, "INVALID_CHECKIN", "weight_kg must be 20-250")
    db = DB(con)
    pt, fac = _home(int(patient_id), db)
    now = to_dt(sim_now())
    r = Rows(int(patient_id), fac, now, ENC_PATIENT, now)
    r.obs(C.PRO_APPETITE, num=vals["appetite"])
    r.obs(C.PRO_PAIN, num=vals["pain"])
    r.obs(C.PRO_ENERGY, num=vals["energy"])
    r.obs(C.PRO_DUMPING, coded=C.YES if dumping else C.NO)
    if wkg is not None:
        r.obs(C.PRO_WEIGHT, num=float(wkg))
    r.commit()
    clean = {**vals, "dumping": dumping, "weight_kg": wkg}
    return _report(int(patient_id), "CHECKIN", clean, r, now)


def record_dose(patient_id: int, course: str, taken: bool, con=None) -> dict:
    if not course or not isinstance(taken, bool):
        raise CareError(400, "INVALID_DOSE", "course and taken (true/false) are required")
    db = DB(con)
    _, fac = _home(int(patient_id), db)
    now = to_dt(sim_now())
    r = Rows(int(patient_id), fac, now, ENC_PATIENT, now)
    r.obs(C.PRO_DOSE, coded=C.YES if taken else C.NO, text=str(course)[:64])
    r.commit()
    return _report(int(patient_id), "DOSE", {"course": str(course)[:64], "taken": taken}, r, now)


def confirm_task(patient_id: int, task_id: str, text: str, con=None) -> dict:
    store = get_store()
    t = store.one("SELECT * FROM care_tasks WHERE id = ?", [task_id])
    if not t:
        raise CareError(404, "NOT_FOUND", "Task not found")
    if int(t["patient_id"]) != int(patient_id):
        raise CareError(403, "FORBIDDEN", "This task belongs to another patient")
    text = (text or "").strip()
    if not text or len(text) > 500:
        raise CareError(400, "INVALID_TEXT", "text must be 1-500 characters")
    db = DB(con)
    _, fac = _home(int(patient_id), db)
    now = to_dt(sim_now())
    r = Rows(int(patient_id), fac, now, ENC_PATIENT, now)
    r.obs(C.CARE_TASK, text=t["type"])
    r.obs(C.PT_CONFIRMED, text=text)
    r.commit()
    # the engine still waits for EMR evidence; this is only the patient's own statement
    return _report(int(patient_id), "CONFIRM", {"task_id": task_id, "text": text}, r, now, task_id=task_id)
