"""One pipeline batch (SPEC §10.3). `python -m pipeline.run [--bootstrap] [--once]`."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import traceback

from shared.config import ANALYTICS_DIR

from . import extract, refs  # noqa: F401
from .db import run_sql_dir, work_connection

LOG_DDL = """CREATE TABLE IF NOT EXISTS pipeline_run_log (run_id INTEGER, started_at TIMESTAMP, finished_at TIMESTAMP,
             status VARCHAR, sim_time TIMESTAMP, steps JSON, row_deltas JSON, error VARCHAR)"""


def sim_time_of(con) -> dt.datetime:
    try:
        r = con.execute("SELECT max(sim_time) FROM raw_sim_tick_log").fetchone()[0]
    except Exception:
        r = None
    return r or dt.datetime(2026, 6, 30, 23, 59, 59)


ORDER = ["refs", "extract", "dq_raw", "stage", "core", "marts", "score", "dq_marts", "publish"]
# v3 fast sim tick (simulator/local.py): the slow population-level marts are rebuilt once per sim month; between those
# rebuilds the previous tables are reused (they only change with a month of new data). pt_*, kpis, care and every other
# mart are rebuilt on each tick.
HEAVY_MARTS = ("joinpoint", "spatial", "survival", "cox", "warning", "rate_surface")


def _fast_skip(con, sim_time: dt.datetime, log) -> tuple:
    con.execute("CREATE TABLE IF NOT EXISTS etl_marts_full (sim_month VARCHAR, built_at TIMESTAMP)")
    month = sim_time.strftime("%Y-%m")
    last = con.execute("SELECT max(sim_month) FROM etl_marts_full").fetchone()[0]
    if last == month:
        log(f"  fast tick: reusing {', '.join(HEAVY_MARTS)} (built for {month})")
        return HEAVY_MARTS
    return ()


def run(bootstrap: bool = False, log=print, stop_after: str | None = None, do_extract: bool = True,
        start_at: str | None = None, extract_local: bool | None = None, fast: bool = False) -> dict:
    """start_at (dev): skip the steps before it and reuse the tables already in the work db.
    extract_local (v3): ingest data/bulk/writeback parts instead of MySQL (default: env EMR_MODE=local).
    fast (v3 sim tick): rebuild HEAVY_MARTS only when the sim month changed."""
    if extract_local is None:
        extract_local = os.environ.get("EMR_MODE", "").lower() == "local"
    if bootstrap and not start_at:
        # a full rebuild starts from an empty file: DuckDB does not return space freed by CREATE OR REPLACE
        from shared.config import ANALYTICS_DIR as _A
        for f in (_A / "work.duckdb", _A / "work.duckdb.wal"):
            f.unlink(missing_ok=True)
    con = work_connection()
    con.execute(LOG_DDL)
    run_id = (con.execute("SELECT coalesce(max(run_id), 0) + 1 FROM pipeline_run_log").fetchone()[0])
    started = dt.datetime.now()
    steps: dict[str, float] = {}
    deltas: dict = {}

    skip_before = ORDER.index(start_at) if start_at else 0

    def step(name, fn):
        if ORDER.index("extract" if name == "bootstrap" else name) < skip_before:
            return {}
        t = time.time()
        out = fn()
        steps[name] = round(time.time() - t, 2)
        log(f"  [{run_id}] {name:10s} {steps[name]:6.1f}s")
        return out

    status, err, logged = "OK", None, False
    extract_enabled = do_extract
    try:
        step("refs", lambda: refs.load_refs(con))
        if bootstrap or not _has(con, "raw_obs"):
            step("bootstrap", lambda: extract.bootstrap_from_parquet(con, log))
            if extract_local and extract_enabled:
                deltas = step("extract", lambda: extract.local_extract(con, log))
        elif extract_enabled:
            deltas = step("extract", lambda: (extract.local_extract if extract_local else extract.incremental_extract)(con, log))
        sim_time = sim_time_of(con)
        params = {"sim_time": sim_time.strftime("%Y-%m-%d %H:%M:%S"), "sim_date": sim_time.strftime("%Y-%m-%d")}
        from . import quality_checks
        step("dq_raw", lambda: quality_checks.check_raw(con, sim_time))
        step("stage", lambda: run_sql_dir(con, "10_staging", **params))
        step("core", lambda: run_sql_dir(con, "20_core", **params))
        if stop_after == "core":
            return {"run_id": run_id, "steps": steps}
        from . import marts
        skip = _fast_skip(con, sim_time, log) if fast else ()
        step("marts", lambda: marts.build_all(con, sim_time, log, skip=skip))
        if not skip and _has(con, "mart_rates"):
            con.execute("CREATE TABLE IF NOT EXISTS etl_marts_full (sim_month VARCHAR, built_at TIMESTAMP)")
            con.execute("INSERT INTO etl_marts_full VALUES (?, now())", [sim_time.strftime("%Y-%m")])
        from . import score
        step("score", lambda: score.score_patients(con, sim_time, log))
        step("dq_marts", lambda: quality_checks.check_marts(con, sim_time))
        from . import publish
        # log the run before publishing so the serve copy of pipeline_run_log already shows this run
        _log_run(con, run_id, started, "OK", steps, deltas, None)
        logged = True
        info = step("publish", lambda: publish.publish(con, run_id, sim_time, deltas))
        log(f"  [{run_id}] published -> {info['active']}  sim_time={sim_time}")
    except Exception as e:
        status, err = "FAILED", f"{e.__class__.__name__}: {e}"
        log(traceback.format_exc())
        raise
    finally:
        if logged:
            con.execute("DELETE FROM pipeline_run_log WHERE run_id = ?", [run_id])
        _log_run(con, run_id, started, status, steps, deltas, err)
        con.close()
    return {"run_id": run_id, "steps": steps, "deltas": deltas, "status": status}


def _log_run(con, run_id, started, status, steps, deltas, err):
    con.execute("INSERT INTO pipeline_run_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [run_id, started, dt.datetime.now(), status, sim_time_of(con), json.dumps(steps), json.dumps(deltas), err])


def _has(con, table: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [table]).fetchone()[0] > 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--stop-after")
    ap.add_argument("--no-extract", action="store_true", help="dev: rebuild from raw_* without contacting MySQL")
    ap.add_argument("--from", dest="start_at", choices=ORDER, help="dev: resume at this step")
    ap.add_argument("--extract-local", action="store_true", default=None,
                    help="v3: extract from data/bulk/writeback Parquet parts (also env EMR_MODE=local)")
    ap.add_argument("--fast", action="store_true", help="v3 sim tick: rebuild the heavy marts once per sim month")
    a = ap.parse_args()
    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    print(run(bootstrap=a.bootstrap, stop_after=a.stop_after, do_extract=not a.no_extract, start_at=a.start_at,
              extract_local=a.extract_local, fast=a.fast))
