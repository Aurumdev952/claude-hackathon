"""Copy care.sqlite into DuckDB (docs/contracts/v3-loop.md §4.1) so marts, ml/, the agent and videos can query it.

Table names in DuckDB all start with `care_` so `pipeline/publish.py` copies them to the serve DB:
care_plans, care_tasks, care_events, care_notifications, care_patient_reports, care_recommendation_outcomes.
Sim-time columns become TIMESTAMPs; JSON stays text.
"""
from __future__ import annotations

import pandas as pd

from .store import TABLES, Store, get_store

NAMES = {"care_plans": "care_plans", "care_tasks": "care_tasks", "care_events": "care_events",
         "notifications": "care_notifications", "patient_reports": "care_patient_reports",
         "recommendation_outcomes": "care_recommendation_outcomes"}
TIME_COLS = {"approved_at", "opens_at", "due_at", "completed_at", "last_reminder_sim", "sim_time", "created_sim",
             "closed_sim", "delivered_sim", "read_sim", "acted_sim", "approved_sim", "first_completion_sim", "due_override"}


def _duck_type(col: str, decl: str) -> str:
    if col in TIME_COLS:
        return "TIMESTAMP"
    d = (decl or "").upper()
    if "INT" in d:
        return "BIGINT"
    if "REAL" in d or "FLOA" in d or "DOUB" in d:
        return "DOUBLE"
    return "VARCHAR"


def to_duckdb(con, store: Store | None = None, log=None) -> dict[str, int]:
    """CREATE OR REPLACE the six care_* tables in `con` from the SQLite store. Empty tables keep their schema."""
    store = store or get_store()
    out = {}
    for src in TABLES:
        dst = NAMES[src]
        info = store.rows(f"PRAGMA table_info({src})")
        cols = [(r["name"], _duck_type(r["name"], r["type"])) for r in info]
        ddl = ", ".join(f'"{c}" {t}' for c, t in cols)
        con.execute(f"CREATE OR REPLACE TABLE {dst} ({ddl})")
        rows = store.rows(f"SELECT * FROM {src}")
        if rows:
            df = pd.DataFrame(rows, columns=[c for c, _ in cols])
            con.register("_care_snap", df)
            sel = ", ".join(f'TRY_CAST("{c}" AS {t}) AS "{c}"' for c, t in cols)
            con.execute(f"INSERT INTO {dst} SELECT {sel} FROM _care_snap")
            con.unregister("_care_snap")
        out[dst] = len(rows)
    if log:
        log(f"    care snapshot: {out}")
    return out
