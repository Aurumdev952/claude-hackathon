"""One pipeline batch (SPEC §10.3). `python -m pipeline.run [--bootstrap] [--once]`."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import time
import traceback

from shared.config import ANALYTICS_DIR

from . import extract, refs
from .db import run_sql_dir, work_connection

LOG_DDL = """CREATE TABLE IF NOT EXISTS pipeline_run_log (run_id INTEGER, started_at TIMESTAMP, finished_at TIMESTAMP,
             status VARCHAR, sim_time TIMESTAMP, steps JSON, row_deltas JSON, error VARCHAR)"""


def sim_time_of(con) -> dt.datetime:
    try:
        r = con.execute("SELECT max(sim_time) FROM raw_sim_tick_log").fetchone()[0]
    except Exception:
        r = None
    return r or dt.datetime(2026, 6, 30, 23, 59, 59)


def run(bootstrap: bool = False, log=print, stop_after: str | None = None) -> dict:
    con = work_connection()
    con.execute(LOG_DDL)
    run_id = (con.execute("SELECT coalesce(max(run_id), 0) + 1 FROM pipeline_run_log").fetchone()[0])
    started = dt.datetime.now()
    steps: dict[str, float] = {}
    deltas: dict = {}

    def step(name, fn):
        t = time.time()
        out = fn()
        steps[name] = round(time.time() - t, 2)
        log(f"  [{run_id}] {name:10s} {steps[name]:6.1f}s")
        return out

    status, err = "OK", None
    try:
        step("refs", lambda: refs.load_refs(con))
        if bootstrap or not _has(con, "raw_obs"):
            step("bootstrap", lambda: extract.bootstrap_from_parquet(con, log))
        else:
            deltas = step("extract", lambda: extract.incremental_extract(con, log))
        sim_time = sim_time_of(con)
        params = {"sim_time": sim_time.strftime("%Y-%m-%d %H:%M:%S"), "sim_date": sim_time.strftime("%Y-%m-%d")}
        from . import quality_checks
        step("dq_raw", lambda: quality_checks.check_raw(con, sim_time))
        step("stage", lambda: run_sql_dir(con, "10_staging", **params))
        step("core", lambda: run_sql_dir(con, "20_core", **params))
        if stop_after == "core":
            return {"run_id": run_id, "steps": steps}
        from . import marts
        step("marts", lambda: marts.build_all(con, sim_time, log))
        from . import score
        step("score", lambda: score.score_patients(con, sim_time, log))
        step("dq_marts", lambda: quality_checks.check_marts(con, sim_time))
        from . import publish
        info = step("publish", lambda: publish.publish(con, run_id, sim_time, deltas))
        log(f"  [{run_id}] published -> {info['active']}  sim_time={sim_time}")
    except Exception as e:
        status, err = "FAILED", f"{e.__class__.__name__}: {e}"
        log(traceback.format_exc())
        raise
    finally:
        con.execute("INSERT INTO pipeline_run_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [run_id, started, dt.datetime.now(), status, sim_time_of(con), json.dumps(steps), json.dumps(deltas), err])
        con.close()
    return {"run_id": run_id, "steps": steps, "deltas": deltas, "status": status}


def _has(con, table: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [table]).fetchone()[0] > 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--stop-after")
    a = ap.parse_args()
    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    print(run(bootstrap=a.bootstrap, stop_after=a.stop_after))
