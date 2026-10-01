"""Writable care-coordination state (docs/contracts/v3-loop.md §4.1): `data/analytics/care.sqlite`.

One connection guarded by a lock (like `api/app_state.py`). The API and the simulator run in different processes, so
the file uses WAL and a busy timeout. The serve DB only ever sees a read-only snapshot (`care.snapshot`).
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Callable, Iterator

from shared.config import ANALYTICS_DIR, SIM_STATE_DIR

DEFAULT_SIM_TIME = "2026-06-30T23:59:59"

SCHEMA = """
CREATE TABLE IF NOT EXISTS care_plans (id TEXT PRIMARY KEY,
  patient_id INT, display_id TEXT, facility_id INT, pathway TEXT, status TEXT,
  source_alert_id TEXT, "trigger" TEXT, approved_by TEXT, approved_at TEXT, channels TEXT,
  model_id TEXT, risk_at_approval REAL, band_at_approval TEXT, propensity REAL,
  due_override TEXT, target_facility_id INT, note TEXT, emr_encounter_id INT, created_sim TEXT, closed_sim TEXT,
  context TEXT /* v3 addition: json clinical facts at approval (alarm, gastrectomy, distance_km, ...) */);
CREATE TABLE IF NOT EXISTS care_tasks (id TEXT PRIMARY KEY, plan_id TEXT, patient_id INT, seq INT, type TEXT, title TEXT,
  status TEXT, opens_at TEXT, due_at TEXT, completed_at TEXT, evidence TEXT, result TEXT, reminders INT,
  last_reminder_sim TEXT, escalation_level INT, created_sim TEXT,
  occurrence INT /* v3 addition: index of a recurring task's occurrence, NULL for one-off tasks */);
CREATE TABLE IF NOT EXISTS care_events (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, task_id TEXT, patient_id INT,
  kind TEXT, detail TEXT, actor TEXT, sim_time TEXT, wall_time TEXT, created_sim TEXT);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, patient_id INT, plan_id TEXT, task_id TEXT, channel TEXT,
  template_key TEXT, title TEXT, body TEXT, created_sim TEXT, delivered_sim TEXT, read_sim TEXT, acted_sim TEXT);
CREATE TABLE IF NOT EXISTS patient_reports (id TEXT PRIMARY KEY, patient_id INT, kind TEXT, payload TEXT,
  emr_encounter_id INT, created_sim TEXT);
CREATE TABLE IF NOT EXISTS recommendation_outcomes (plan_id TEXT PRIMARY KEY, patient_id INT, pathway TEXT,
  approved_sim TEXT, first_completion_sim TEXT, days_to_completion INT, adhered INT, on_time INT, finding TEXT,
  cancer_found INT, stage_at_dx TEXT, channels TEXT, reminders INT, escalation_level INT, district_code TEXT,
  distance_km REAL, sex TEXT, age_band TEXT, risk_at_approval REAL, propensity REAL, closed_sim TEXT, created_sim TEXT);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, created TEXT);
CREATE INDEX IF NOT EXISTS ix_tasks_plan ON care_tasks(plan_id);
CREATE INDEX IF NOT EXISTS ix_tasks_patient ON care_tasks(patient_id);
CREATE INDEX IF NOT EXISTS ix_plans_patient ON care_plans(patient_id);
CREATE INDEX IF NOT EXISTS ix_events_plan ON care_events(plan_id);
CREATE INDEX IF NOT EXISTS ix_notif_patient ON notifications(patient_id);
"""
TABLES = ("care_plans", "care_tasks", "care_events", "notifications", "patient_reports", "recommendation_outcomes")


class Store:
    def __init__(self, path: str | Path | None = None):
        if path is None:
            ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
            path = ANALYTICS_DIR / "care.sqlite"
        self.path = str(path)
        self.lock = threading.RLock()
        self.con = sqlite3.connect(self.path, check_same_thread=False, timeout=30, isolation_level=None)
        self.con.row_factory = sqlite3.Row
        if self.path != ":memory:":
            self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(SCHEMA)

    # ------------------------------------------------------------------ queries
    def rows(self, sql: str, params: list | tuple = ()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.con.execute(sql, list(params)).fetchall()]

    def one(self, sql: str, params: list | tuple = ()) -> dict | None:
        r = self.rows(sql, params)
        return r[0] if r else None

    def execute(self, sql: str, params: list | tuple = ()):
        with self.lock:
            return self.con.execute(sql, list(params))

    @contextlib.contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Serialised write transaction (thread lock + BEGIN IMMEDIATE across processes)."""
        with self.lock:
            self.con.execute("BEGIN IMMEDIATE")
            try:
                yield self.con
            except BaseException:
                self.con.execute("ROLLBACK")
                raise
            self.con.execute("COMMIT")

    def insert(self, table: str, row: dict, con: sqlite3.Connection | None = None, replace: bool = False):
        cols = list(row)
        q = (f"INSERT {'OR REPLACE ' if replace else ''}INTO {table} ({','.join(_q(c) for c in cols)}) "
             f"VALUES ({','.join('?' * len(cols))})")
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in row.values()]
        with self.lock:
            (con or self.con).execute(q, vals)

    def update(self, table: str, key: str, changes: dict, con: sqlite3.Connection | None = None):
        if not changes:
            return
        sets = ",".join(f"{_q(c)} = ?" for c in changes)
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in changes.values()]
        with self.lock:
            (con or self.con).execute(f"UPDATE {table} SET {sets} WHERE id = ?", vals + [key])

    # ------------------------------------------------------------------ outbox
    def push(self, payload: dict, con: sqlite3.Connection | None = None):
        with self.lock:
            (con or self.con).execute("INSERT INTO outbox (payload, created) VALUES (?, ?)",
                                      [json.dumps(payload, default=str), _wall()])

    def drain(self, limit: int = 500) -> list[dict]:
        """Pop queued WS events (oldest first). Used by the API `_watch()` loop."""
        with self.tx() as c:
            rows = c.execute("SELECT id, payload FROM outbox ORDER BY id LIMIT ?", [limit]).fetchall()
            if rows:
                c.execute("DELETE FROM outbox WHERE id <= ?", [rows[-1]["id"]])
        return [json.loads(r["payload"]) for r in rows]

    def close(self):
        with self.lock:
            self.con.close()


def _q(c: str) -> str:
    return f'"{c}"' if c == "trigger" else c


def _wall() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_STORE: Store | None = None
_STORE_LOCK = threading.Lock()


def get_store() -> Store:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = Store()
        return _STORE


def set_store(store: Store | None) -> Store | None:
    """Tests swap in a temp/in-memory store; returns the previous one."""
    global _STORE
    with _STORE_LOCK:
        old, _STORE = _STORE, store
        return old


# ---------------------------------------------------------------------- sim clock
_CLOCK: Callable[[], str] | None = None


def set_clock(fn: Callable[[], str] | None):
    """Override the sim clock (tests). fn returns an ISO sim-time string."""
    global _CLOCK
    _CLOCK = fn


def sim_now() -> str:
    """The simulated 'now': data/sim_state/sim_state.json, else the serve DB current.json, else the bootstrap end."""
    if _CLOCK is not None:
        return _norm(_CLOCK())
    for p, key in ((SIM_STATE_DIR / "sim_state.json", "sim_time"), (ANALYTICS_DIR / "current.json", "sim_time")):
        try:
            v = json.load(open(p)).get(key)
            if v:
                return _norm(v)
        except (FileNotFoundError, json.JSONDecodeError, AttributeError):
            continue
    return DEFAULT_SIM_TIME


def _norm(v: Any) -> str:
    if isinstance(v, (dt.datetime, dt.date)):
        v = v.isoformat()
    s = str(v).replace(" ", "T").rstrip("Z")
    if len(s) == 10:
        s += "T00:00:00"
    return s[:19]


def to_dt(v: Any) -> dt.datetime:
    return dt.datetime.fromisoformat(_norm(v))


def iso(v: dt.datetime | dt.date) -> str:
    if isinstance(v, dt.date) and not isinstance(v, dt.datetime):
        v = dt.datetime.combine(v, dt.time())
    return v.strftime("%Y-%m-%dT%H:%M:%S")
