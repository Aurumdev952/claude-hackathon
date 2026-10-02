"""simulator/local.py (sim clock) and pipeline/extract.py:local_extract. The pre-simulated future of the current
dataset is read (symlinked); everything written goes to a tmp directory. No pipeline run here (see the e2e in the
L1 report: `make advance DAYS=7`)."""
import datetime as dt
import json

import duckdb
import polars as pl
import pytest

from care import emr
from generator.writers import SCHEMAS
from shared import config


@pytest.fixture()
def world(tmp_path, monkeypatch):
    fut = config.BULK_DIR / "future"
    if not (fut / "encounter.parquet").exists():
        pytest.skip("no generated dataset")
    bulk = tmp_path / "bulk"
    bulk.mkdir()
    (bulk / "future").symlink_to(fut.resolve())
    monkeypatch.setattr(config, "BULK_DIR", bulk)
    monkeypatch.setattr(config, "SIM_STATE_DIR", tmp_path / "sim_state")
    monkeypatch.setenv("EMR_MODE", "local")
    from simulator import local
    return local, emr.get_adapter(), fut


def test_advance_replays_window_and_moves_clock(world):
    local, ad, fut = world
    t0 = local.sim_time()
    assert t0 == emr.SIM_START
    out = local.advance(3, run_pipeline=False, care_world=False, log=lambda *_: None)
    t1 = t0 + dt.timedelta(days=3)
    assert out["sim_time_to"] == t1.strftime("%Y-%m-%dT%H:%M:%S") and local.sim_time() == t1
    expect = (pl.scan_parquet(fut / "encounter.parquet")
              .filter((pl.col("encounter_datetime") > t0) & (pl.col("encounter_datetime") <= t1)).collect())
    enc = ad.read("encounter")
    assert enc.height == expect.height == out["encounters_added"] > 0
    assert set(enc["encounter_id"]) == set(expect["encounter_id"])  # replayed rows keep their generator ids
    obs = ad.read("obs")
    assert set(obs["encounter_id"]) <= set(enc["encounter_id"]) and obs.height == out["obs_added"]
    assert dict(obs.schema) == SCHEMAS["obs"]
    tick = json.load(open(config.SIM_STATE_DIR / "last_tick.json"))
    assert tick["tick_id"] == 1 and tick["sim_time"] == out["sim_time_to"] and ad.read("sim_tick_log").height == 1
    out2 = local.advance(2, run_pipeline=False, care_world=False, log=lambda *_: None)
    assert out2["tick_id"] == 2 and out2["sim_time_from"] == out["sim_time_to"]
    assert ad.read("encounter")["encounter_id"].n_unique() == ad.read("encounter").height  # no row twice
    st = local.status()
    assert st["sim_time"] == out2["sim_time_to"] and st["sim_end"] == "2027-12-31T23:59:59"
    assert st["running_job"] is None and set(st["auto"]) >= {"enabled", "seconds_per_day"}


def test_superseded_rows_are_not_replayed(world):
    local, ad, fut = world
    t0 = local.sim_time()
    t1 = t0 + dt.timedelta(days=5)
    win = (pl.scan_parquet(fut / "encounter.parquet")
           .filter((pl.col("encounter_datetime") > t0) & (pl.col("encounter_datetime") <= t1)).collect())
    pid = int(win.group_by("patient_id").len().sort("len", descending=True)["patient_id"][0])
    ad.supersede(pid, (t0.date() - dt.date(1970, 1, 1)).days, "test")
    local.advance(5, run_pipeline=False, care_world=False, log=lambda *_: None)
    enc = ad.read("encounter")
    assert pid not in set(enc["patient_id"]) and enc.height == win.filter(pl.col("patient_id") != pid).height


def test_lock_gives_busy_error(world):
    local, ad, _ = world
    with local._Lock(config.SIM_STATE_DIR / "advance.lock"):
        with pytest.raises(local.BusyError):
            local.advance(1, run_pipeline=False, care_world=False, log=lambda *_: None)


def test_local_extract_anti_join_and_parts(world):
    local, ad, _ = world
    from pipeline import extract
    local.advance(2, run_pipeline=False, care_world=False, log=lambda *_: None)
    con = duckdb.connect()
    for t in extract.WATERMARKED:
        cols = ", ".join(f'"{c}" {"TIMESTAMP" if str(dt_).startswith("Datetime") else ("DATE" if str(dt_) == "Date" else ("VARCHAR" if str(dt_) == "String" else "BIGINT" if "Int" in str(dt_) else "DOUBLE"))}'
                         for c, dt_ in SCHEMAS[t].items())
        con.execute(f"CREATE TABLE raw_{t} ({cols})")
    con.execute("CREATE TABLE raw_sim_tick_log (tick_id INTEGER, sim_time TIMESTAMP, wall_time TIMESTAMP, "
                "encounters_added INTEGER, obs_added INTEGER)")
    first = extract.local_extract(con, log=lambda *_: None)
    assert first["encounter"] == ad.read("encounter").height > 0 and first["obs"] == ad.read("obs").height
    assert con.execute("SELECT max(sim_time) FROM raw_sim_tick_log").fetchone()[0] == local.sim_time()
    again = extract.local_extract(con, log=lambda *_: None)
    assert sum(v for k, v in again.items()) == 0  # parts are tracked in etl_local_parts
    con.execute("DELETE FROM etl_local_parts")      # re-reading parts never duplicates ids (anti-join)
    third = extract.local_extract(con, log=lambda *_: None)
    assert third["encounter"] == 0 and third["obs"] == 0
