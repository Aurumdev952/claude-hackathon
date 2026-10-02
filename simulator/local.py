"""MySQL-free sim clock (docs/contracts/v3-loop.md §3). `python -m simulator.local [--days 7 | --auto | --status]`

`advance(days)` moves the simulated "now" from t0 to t1 = t0 + days and makes the EMR, the care engine and the
analytics catch up, in this order:

1. replay the pre-simulated future rows dated in (t0, t1] (`data/bulk/future`, D-07) plus deferred re-simulated rows
   (`writeback/deferred`), excluding superseded patients' rows;
2. `simulator.care_world.step(t0, t1)`: how patients react to open care tasks (endoscopies, labs, CHW visits, ...);
3. write the write-back parts (`care.emr`), one `sim_tick_log` row, and `data/sim_state/sim_state.json`;
4. `pipeline.run(extract_local=True)` through the core step (local extract ingests the new parts);
5. `care.engine.reconcile(t0, t1, con)` on the work DB (evidence straight from the new raw rows) when importable;
6. care snapshot, marts (fast tick: heavy population marts once per sim month), score, publish;
   then `ml.retrain.maybe_retrain(t1)` when importable (L3: retrain + forecast refit every 30 sim days);
7. `data/sim_state/last_tick.json` (the API `_watch()` broadcasts it as `sim_tick`).

A file lock (`data/sim_state/advance.lock`) serialises callers: a second caller gets `BusyError`. The auto clock
(`--auto`, `make sim-local`) follows `data/sim_state/control.json` {paused, seconds_per_day, demo_mode,
fast_forward_days}. The sim ends at 2027-12-31.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import time
from pathlib import Path

import polars as pl

from care import emr
from generator.writers import ALL_TABLES
from shared import config

SIM_END = dt.datetime(2027, 12, 31, 23, 59, 59)
SIM_START = emr.SIM_START
DEFAULT_SECONDS_PER_DAY = 60


class BusyError(RuntimeError):
    """Another advance is running (the lock file is held)."""


# ----------------------------------------------------------------------------------------------- files
def _dir() -> Path:
    return config.SIM_STATE_DIR


def _json(path: Path, default):
    try:
        return json.load(open(path))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    json.dump(obj, open(tmp, "w"), default=str, indent=1)
    os.replace(tmp, path)


def sim_time() -> dt.datetime:
    return emr.current_sim_time(_dir())


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S")


# ----------------------------------------------------------------------------------------------- replay
def replay_rows(t0: dt.datetime, t1: dt.datetime, adapter) -> dict[str, pl.DataFrame]:
    """Pre-simulated future rows + deferred re-simulated rows in (t0, t1], superseded rows removed."""
    fut_dir = config.BULK_DIR / "future"
    fut = {n: pl.scan_parquet(fut_dir / f"{n}.parquet") for n in ALL_TABLES if (fut_dir / f"{n}.parquet").exists()}
    sup = adapter.superseded()
    rows = emr.drop_superseded(emr.window(fut, t0, t1), sup, 0)
    dfr = adapter.deferred()
    if dfr:
        d = emr.drop_superseded(emr.window(dfr, t0, t1), sup, "_sup")
        for t, df in d.items():
            if df.height:
                df = df.drop("_sup")
                rows[t] = pl.concat([rows[t], df], how="vertical_relaxed") if rows.get(t) is not None else df
    return rows


# ----------------------------------------------------------------------------------------------- care hooks
def _care_reconcile(t0: dt.datetime, t1: dt.datetime, log) -> dict:
    try:
        from care import engine
    except Exception as e:  # noqa: BLE001 - L2 builds the engine in parallel
        log(f"  care engine not importable ({e.__class__.__name__}); skipping reconcile")
        return {"skipped": True}
    from pipeline.db import work_connection
    con = work_connection()
    try:
        out = engine.reconcile(t0, t1, con, log=log)
        try:
            from care import snapshot
            snapshot.to_duckdb(con)
        except Exception as e:  # noqa: BLE001
            log(f"  care snapshot skipped ({e.__class__.__name__}: {e})")
        return out
    finally:
        con.close()


def _learning_loop(t1: dt.datetime, log) -> dict | None:
    try:
        from ml import retrain
    except Exception as e:  # noqa: BLE001 - L3 module optional
        log(f"  learning loop not importable ({e.__class__.__name__}); skipping")
        return None
    try:
        out = retrain.maybe_retrain(t1, log=log)
    except Exception as e:  # noqa: BLE001 - never stop the clock
        log(f"  learning loop failed: {e.__class__.__name__}: {e}")
        return {"error": f"{e.__class__.__name__}: {e}"}
    if not out:
        return None
    return {k: (v.get("status") or v.get("decision") or "done") if isinstance(v, dict) else v for k, v in out.items()}


# ----------------------------------------------------------------------------------------------- advance
class _Lock:
    def __init__(self, path: Path):
        self.path, self.fh = path, None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(self.path, "a+")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.fh.close()
            info = _json(_dir() / "advance_progress.json", {})
            raise BusyError(f"an advance is already running ({info.get('step', 'unknown step')})") from None
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def advance(days: int, *, on_progress=None, fast: bool = True, run_pipeline: bool = True, care_world: bool = True,
            learning_loop: bool = True, seed: int | None = None, log=print) -> dict:
    """Advance the sim clock by `days` (1-366). Returns {tick_id, sim_time_from, sim_time_to, rows, care, pipeline_s,
    status, ...}. Raises BusyError if another advance holds the lock."""
    days = int(days)
    if not 1 <= days <= 366:
        raise ValueError("days must be 1-366")
    wall0 = time.time()
    prog_file = _dir() / "advance_progress.json"

    def prog(frac: float, step: str):
        _write(prog_file, {"pid": os.getpid(), "days": days, "progress": round(frac, 3), "step": step,
                           "started": dt.datetime.fromtimestamp(wall0).isoformat(), "running": True})
        if on_progress:
            on_progress(frac, step)

    with _Lock(_dir() / "advance.lock"):
        t0 = sim_time()
        t1 = min(t0 + dt.timedelta(days=days), SIM_END)
        if t1 <= t0:
            return {"tick_id": None, "sim_time_from": _iso(t0), "sim_time_to": _iso(t0), "rows": {}, "care": {},
                    "pipeline_s": 0.0, "status": "horizon"}
        ad = emr.get_adapter()
        timings: dict[str, float] = {}
        prog(0.02, "replay")
        t = time.time()
        rows = replay_rows(t0, t1, ad)
        counts = ad.write(rows, tick=f"replay {_iso(t1)}")
        timings["replay"] = round(time.time() - t, 2)
        cw: dict = {}
        if care_world:
            prog(0.12, "care world")
            t = time.time()
            try:
                from . import care_world as cwm
                cw = cwm.step(t0, t1, adapter=ad, seed=seed, log=log, replayed=rows)
            except Exception as e:  # noqa: BLE001 - the clock keeps going without the care world
                log(f"  care world failed: {e.__class__.__name__}: {e}")
                cw = {"error": f"{e.__class__.__name__}: {e}"}
            timings["care_world"] = round(time.time() - t, 2)
        for k, v in (cw.get("rows") or {}).items():
            counts[k] = counts.get(k, 0) + v
        n_enc, n_obs = int(counts.get("encounter", 0)), int(counts.get("obs", 0))
        tick_id = ad.log_tick(t1, n_enc, n_obs)
        state = _json(_dir() / "sim_state.json", {})
        state.update({"sim_time": _iso(t1), "tick_id": tick_id, "updated_at": dt.datetime.now().isoformat()})
        _write(_dir() / "sim_state.json", state)
        care: dict = {}
        learn: dict | None = None
        pipe_s = 0.0
        if run_pipeline:
            from pipeline import run as prun
            t = time.time()
            prog(0.25, "pipeline: extract, staging, core")
            r1 = prun.run(do_extract=True, extract_local=True, stop_after="core", log=log)
            prog(0.45, "care reconcile")
            tc = time.time()
            care = _care_reconcile(t0, t1, log)
            timings["reconcile"] = round(time.time() - tc, 2)
            prog(0.55, "pipeline: marts, score, publish")
            r2 = prun.run(start_at="marts", fast=fast, log=log)
            pipe_s = round(time.time() - t, 2)
            timings.update({f"pipeline.{k}": v for k, v in {**r1.get("steps", {}), **r2.get("steps", {})}.items()})
            if learning_loop:  # L3: retrain + forecast refit every N sim days (no-op otherwise), republishes itself
                prog(0.9, "learning loop")
                tl = time.time()
                learn = _learning_loop(t1, log)
                timings["learning_loop"] = round(time.time() - tl, 2)
        persons = int(counts.get("person", 0))
        info = {"tick_id": tick_id, "sim_time": _iso(t1), "sim_time_from": _iso(t0), "sim_time_to": _iso(t1),
                "encounters_added": n_enc, "obs_added": n_obs, "persons_added": persons,
                "rows": {k: int(v) for k, v in counts.items() if v}, "care": care,
                "care_world": {k: v for k, v in cw.items() if k != "outcomes"} | {"outcomes": len(cw.get("outcomes", []))},
                "learning_loop": learn, "pipeline_s": pipe_s, "seconds": round(time.time() - wall0, 2), "timings": timings,
                "status": "done", "wall_time": dt.datetime.now(dt.timezone.utc).isoformat()}
        _write(_dir() / "last_tick.json", info)
        _write(prog_file, {"pid": os.getpid(), "days": days, "progress": 1.0, "step": "done", "running": False,
                           "finished": dt.datetime.now().isoformat(), "tick_id": tick_id})
        if on_progress:
            on_progress(1.0, "done")
        log(f"tick {tick_id}: {_iso(t0)} -> {_iso(t1)}  +{n_enc} encounters +{n_obs} obs  "
            f"care world {cw.get('summary', {})}  pipeline {pipe_s:.1f}s  total {info['seconds']:.1f}s")
        return info


def status() -> dict:
    """{sim_time, sim_end, auto: {enabled, seconds_per_day}, running_job}."""
    auto = _json(_dir() / "auto.json", {})
    alive = False
    if auto.get("pid"):
        try:
            os.kill(int(auto["pid"]), 0)
            alive = time.time() - float(auto.get("beat", 0)) < max(120, 3 * float(auto.get("interval", 60)))
        except (OSError, ValueError):
            alive = False
    ctl = _json(_dir() / "control.json", {})
    prog = _json(_dir() / "advance_progress.json", {})
    running = None
    if prog.get("running"):
        try:
            os.kill(int(prog["pid"]), 0)
            running = {k: prog.get(k) for k in ("days", "progress", "step", "started", "pid")}
        except (OSError, ValueError, KeyError):
            running = None
    now = sim_time()
    return {"sim_time": _iso(now), "sim_end": _iso(SIM_END), "days_left": max(0, (SIM_END - now).days),
            "auto": {"enabled": alive and not ctl.get("paused", False), "running": alive,
                     "paused": bool(ctl.get("paused", False)),
                     "seconds_per_day": float(ctl.get("seconds_per_day") or DEFAULT_SECONDS_PER_DAY),
                     "demo_mode": bool(ctl.get("demo_mode", False))},
            "running_job": running, "last_tick": _json(_dir() / "last_tick.json", None)}


def auto(log=print, max_ticks: int | None = None):
    """Auto clock: one tick per interval, paced by control.json (seconds_per_day; demo_mode = 7 days per tick)."""
    from shared.config import generator_cfg
    sim_cfg = generator_cfg().get("simulator", {})
    n = 0
    while max_ticks is None or n < max_ticks:
        c = _json(_dir() / "control.json", {})
        demo = bool(c.get("demo_mode"))
        days = int((sim_cfg.get("demo", {}) or {}).get("sim_days_per_tick", 7)) if demo else 1
        spd = float(c.get("seconds_per_day") or DEFAULT_SECONDS_PER_DAY)
        interval = float((sim_cfg.get("demo", {}) or {}).get("tick_seconds", 30)) if demo else spd * days
        _write(_dir() / "auto.json", {"pid": os.getpid(), "beat": time.time(), "interval": interval,
                                      "started": dt.datetime.now().isoformat()})
        ff = int(c.get("fast_forward_days", 0) or 0)
        if ff:
            c["fast_forward_days"] = 0
            _write(_dir() / "control.json", c)
        started = time.time()
        if not c.get("paused") or ff:
            if sim_time() >= SIM_END:
                log("simulation horizon reached (2027-12-31)")
            else:
                try:
                    advance(min(366, days + ff) if not c.get("paused") else ff, log=log)
                    n += 1
                except BusyError as e:
                    log(f"auto clock: {e}; waiting")
        while time.time() - started < interval:
            time.sleep(1.0)
            _write(_dir() / "auto.json", {"pid": os.getpid(), "beat": time.time(), "interval": interval})
            c2 = _json(_dir() / "control.json", {})
            if int(c2.get("fast_forward_days", 0) or 0) or bool(c2.get("paused")) != bool(c.get("paused")):
                break


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=None)
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--no-pipeline", action="store_true", help="only write the EMR rows (no analytics refresh)")
    ap.add_argument("--full", action="store_true", help="rebuild every mart (no fast tick)")
    ap.add_argument("--no-learning-loop", action="store_true", help="skip ml.retrain.maybe_retrain after the tick")
    a = ap.parse_args()
    if a.status:
        print(json.dumps(status(), indent=1, default=str))
    elif a.auto:
        auto()
    else:
        out = advance(a.days or 7, run_pipeline=not a.no_pipeline, fast=not a.full, learning_loop=not a.no_learning_loop)
        print(json.dumps({k: v for k, v in out.items() if k != "timings"}, indent=1, default=str))
        print("timings:", json.dumps(out.get("timings", {})))
