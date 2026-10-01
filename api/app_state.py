"""Small writable state next to the read-only serve DB (SPEC §11.5): alert status, case notes, insight cache."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading

from shared.config import ANALYTICS_DIR

_LOCK = threading.Lock()


def _con(path=None):
    """path=None -> the app's state file; tests pass ':memory:' so they never touch real alert statuses or notes."""
    if path is None:
        ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
        path = ANALYTICS_DIR / "app_state.sqlite"
    c = sqlite3.connect(path, check_same_thread=False)
    c.execute("""CREATE TABLE IF NOT EXISTS alert_status (alert_id TEXT PRIMARY KEY, status TEXT, note TEXT, reason TEXT,
                 facility_id INTEGER, updated_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS case_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, facility_id INTEGER,
                 note TEXT, created_at TEXT)""")
    c.execute("CREATE TABLE IF NOT EXISTS insight_cache (view TEXT PRIMARY KEY, fact_hash TEXT, cards TEXT, generated_at TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS sim_control (k TEXT PRIMARY KEY, v TEXT)")
    return c


CON = _con()


def alert_statuses(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    with _LOCK:
        q = f"SELECT alert_id, status, note, reason, updated_at FROM alert_status WHERE alert_id IN ({','.join('?' * len(ids))})"
        return {r[0]: {"status": r[1], "note": r[2], "reason": r[3], "updated_at": r[4]} for r in CON.execute(q, ids).fetchall()}


def set_alert_status(alert_id: str, status: str, note: str | None, reason: str | None, facility_id: int | None):
    with _LOCK:
        CON.execute("INSERT OR REPLACE INTO alert_status VALUES (?, ?, ?, ?, ?, ?)",
                    [alert_id, status, note, reason, facility_id, dt.datetime.now(dt.timezone.utc).isoformat()])
        CON.commit()


def add_case_note(patient_id: int, facility_id: int | None, note: str) -> dict:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    with _LOCK:
        cur = CON.execute("INSERT INTO case_notes (patient_id, facility_id, note, created_at) VALUES (?, ?, ?, ?)",
                          [patient_id, facility_id, note, now])
        CON.commit()
        return {"id": cur.lastrowid, "patient_id": patient_id, "note": note, "created_at": now}


def case_notes(patient_id: int) -> list[dict]:
    with _LOCK:
        return [{"id": r[0], "note": r[1], "created_at": r[2]} for r in
                CON.execute("SELECT id, note, created_at FROM case_notes WHERE patient_id = ? ORDER BY id DESC", [patient_id]).fetchall()]


def cached_insights(view: str, fact_hash: str) -> list | None:
    with _LOCK:
        r = CON.execute("SELECT cards FROM insight_cache WHERE view = ? AND fact_hash = ?", [view, fact_hash]).fetchone()
    return json.loads(r[0]) if r else None


def store_insights(view: str, fact_hash: str, cards: list):
    with _LOCK:
        CON.execute("INSERT OR REPLACE INTO insight_cache VALUES (?, ?, ?, ?)",
                    [view, fact_hash, json.dumps(cards), dt.datetime.now(dt.timezone.utc).isoformat()])
        CON.commit()
