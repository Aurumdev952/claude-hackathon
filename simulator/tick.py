"""Live simulator (SPEC §10.1). `python -m simulator.tick [--once] [--demo]`

Each tick advances the sim clock and inserts the hospital activity that happens in that window. Activity comes from
the generator's pre-simulated future (data/bulk/future, D-07), so new encounters keep following the same latent
trajectories and planted mechanisms. Insert-only, one transaction per tick, ids above every bulk id (ETL watermarks).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time

import polars as pl
import pymysql

from generator.writers import COLUMNS
from shared.config import BULK_DIR, SIM_STATE_DIR, generator_cfg, mysql_params

FUT = BULK_DIR / "future"
STATE = SIM_STATE_DIR / "state.json"
CONTROL = SIM_STATE_DIR / "control.json"
LAST = SIM_STATE_DIR / "last_tick.json"
HISTORY_END = dt.datetime(2026, 6, 30, 23, 59, 59)
BATCH = 5000

ORDER = ["person", "person_name", "person_address", "person_attribute", "patient", "patient_identifier", "visit", "encounter",
         "obs", "orders", "drug_order", "patient_program"]


def _json(path, default):
    try:
        return json.load(open(path))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path, obj):
    SIM_STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    json.dump(obj, open(tmp, "w"), default=str)
    os.replace(tmp, path)


def window_rows(t0: dt.datetime, t1: dt.datetime) -> dict[str, pl.DataFrame]:
    scan = lambda n: pl.scan_parquet(FUT / f"{n}.parquet")  # noqa: E731
    inw = lambda c: (pl.col(c) > t0) & (pl.col(c) <= t1)  # noqa: E731
    enc = scan("encounter").filter(inw("encounter_datetime")).collect()
    eids = enc["encounter_id"]
    out = {
        "person": scan("person").filter(inw("date_created")).collect(),
        "person_address": scan("person_address").filter(inw("start_date")).collect(),
        "visit": scan("visit").filter(inw("date_started")).collect(),
        "encounter": enc,
        "obs": scan("obs").filter(pl.col("encounter_id").is_in(eids.implode())).collect().sort("obs_id"),
        "orders": scan("orders").filter(pl.col("encounter_id").is_in(eids.implode())).collect(),
        "patient_program": scan("patient_program").filter(inw("date_enrolled")).collect(),
    }
    pids = out["person"]["person_id"].implode()
    for n, key in (("person_name", "person_id"), ("person_attribute", "person_id"), ("patient", "patient_id"),
                   ("patient_identifier", "patient_id")):
        out[n] = scan(n).filter(pl.col(key).is_in(pids)).collect()
    out["drug_order"] = scan("drug_order").filter(pl.col("order_id").is_in(out["orders"]["order_id"].implode())).collect()
    # a visit started in an earlier tick may receive encounters now: only insert visits not yet present (insert-only)
    return out


def insert(conn, frames: dict[str, pl.DataFrame]) -> dict[str, int]:
    counts = {}
    cur = conn.cursor()
    for name in ORDER:
        df = frames.get(name)
        if df is None or df.height == 0:
            counts[name] = 0
            continue
        cols = COLUMNS[name]
        df = df.select(cols)
        sql = f"INSERT IGNORE INTO {name} ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))})"
        rows = df.rows()
        for i in range(0, len(rows), BATCH):
            cur.executemany(sql, rows[i:i + BATCH])
        counts[name] = len(rows)
    return counts


def tick(conn, state: dict, days: float) -> dict:
    t0 = dt.datetime.fromisoformat(state["sim_time"])
    t1 = t0 + dt.timedelta(days=days)
    frames = window_rows(t0, t1)
    conn.begin()
    try:
        counts = insert(conn, frames)
        cur = conn.cursor()
        cur.execute("INSERT INTO sim_tick_log (sim_time, wall_time, encounters_added, obs_added) VALUES (%s, %s, %s, %s)",
                    [t1, dt.datetime.now(), counts.get("encounter", 0), counts.get("obs", 0)])
        tick_id = cur.lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    state.update({"sim_time": t1.isoformat(), "tick_id": tick_id})
    _write(STATE, state)
    info = {"tick_id": tick_id, "sim_time": t1.isoformat(), "encounters_added": counts.get("encounter", 0),
            "obs_added": counts.get("obs", 0), "persons_added": counts.get("person", 0),
            "wall_time": dt.datetime.now(dt.timezone.utc).isoformat()}
    _write(LAST, info)
    return info


def connect():
    return pymysql.connect(**mysql_params("openmrs"), autocommit=False, charset="utf8mb4")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--days", type=float)
    a = ap.parse_args()
    cfg = generator_cfg()["simulator"]
    state = _json(STATE, {"sim_time": HISTORY_END.isoformat(), "tick_id": 0})
    conn = connect()
    while True:
        c = _json(CONTROL, {})
        demo = a.demo or c.get("demo_mode") or os.environ.get("DEMO_MODE", "false").lower() == "true"
        interval = cfg["demo"]["tick_seconds"] if demo else int(os.environ.get("TICK_SECONDS", cfg["tick_seconds"]))
        days = a.days or (cfg["demo"]["sim_days_per_tick"] if demo else float(os.environ.get("SIM_DAYS_PER_TICK", cfg["sim_days_per_tick"])))
        ff = int(c.get("fast_forward_days", 0) or 0)
        if ff:
            days += ff
            c["fast_forward_days"] = 0
            _write(CONTROL, c)
        if not c.get("paused"):
            if dt.datetime.fromisoformat(state["sim_time"]) >= dt.datetime(2027, 12, 31):
                print("simulation horizon reached (2027-12-31); nothing left to replay")
            else:
                t = time.time()
                info = tick(conn, state, days)
                print(f"tick {info['tick_id']}: sim_time={info['sim_time']} +{info['encounters_added']} encounters "
                      f"+{info['obs_added']} obs ({time.time() - t:.1f}s)", flush=True)
        if a.once:
            break
        time.sleep(interval)


if __name__ == "__main__":
    main()
