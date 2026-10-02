"""Regression tests for the F1 review fixes in the sim clock and the care world (simulator/local.py,
simulator/care_world.py). Everything is written to tmp dirs; the generated dataset (DATA_DIR) is only read."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3

import polars as pl
import pytest

from care import emr, evidence
from care.emr import ParquetEMR
from generator.dates import d
from shared import config
from shared.concepts import C
from shared.config import LATENT_DIR
from simulator import care_world

T0 = dt.datetime(2026, 7, 1, 23, 59, 59)
T1 = dt.datetime(2026, 7, 31, 23, 59, 59)
T2 = dt.datetime(2026, 8, 30, 23, 59, 59)
SCHEMA = """
CREATE TABLE care_plans (id TEXT PRIMARY KEY, patient_id INT, display_id TEXT, facility_id INT, pathway TEXT, status TEXT,
  source_alert_id TEXT, "trigger" TEXT, approved_by TEXT, approved_at TEXT, channels TEXT, model_id TEXT,
  risk_at_approval REAL, band_at_approval TEXT, propensity REAL, due_override TEXT, target_facility_id INT, note TEXT,
  emr_encounter_id INT, created_sim TEXT, closed_sim TEXT, context TEXT);
CREATE TABLE care_tasks (id TEXT PRIMARY KEY, plan_id TEXT, patient_id INT, seq INT, type TEXT, title TEXT, status TEXT,
  opens_at TEXT, due_at TEXT, completed_at TEXT, evidence TEXT, result TEXT, reminders INT, last_reminder_sim TEXT,
  escalation_level INT, created_sim TEXT, occurrence INT);
CREATE TABLE notifications (id TEXT PRIMARY KEY, patient_id INT, plan_id TEXT, task_id TEXT, channel TEXT,
  template_key TEXT, title TEXT, body TEXT, created_sim TEXT, delivered_sim TEXT, read_sim TEXT, acted_sim TEXT);
"""


@pytest.fixture(scope="module")
def healthy():
    p = LATENT_DIR / "gastric_cases.parquet"
    if not p.exists() or "stage_months" not in pl.read_parquet_schema(p):
        pytest.skip("needs a v3-generated dataset (latent stage_months)")
    cases = pl.read_parquet(p)
    persons = pl.read_parquet(LATENT_DIR / "persons.parquet")
    return persons.filter(~pl.col("person_id").is_in(cases["person_id"].implode()) & (pl.col("birth_day") < d("1975-01-01"))
                          & (pl.col("death_day") > d("2028-01-01")) & (pl.col("person_id") < 100_000))["person_id"].to_list()


def _db(path, tasks, plan_extra=None):
    """tasks: (task_id, plan_id, pid, seq, type, status, opens_at, reminders, occurrence)."""
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for plan_id in sorted({t[1] for t in tasks}):
        pid = next(t[2] for t in tasks if t[1] == plan_id)
        con.execute("""INSERT INTO care_plans (id, patient_id, facility_id, pathway, status, "trigger", channels, approved_at,
                       created_sim) VALUES (?, ?, 1201, ?, 'ACTIVE', 'RISK_BAND_HIGH', '["APP","SMS","CHW"]', ?, ?)""",
                    [plan_id, pid, (plan_extra or {}).get("pathway", "TEST"), T0.isoformat(), T0.isoformat()])
    for tid, plan_id, pid, seq, ttype, status, opens, rem, occ in tasks:
        con.execute("""INSERT INTO care_tasks (id, plan_id, patient_id, seq, type, title, status, opens_at, due_at, reminders,
                       escalation_level, created_sim, occurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                    [tid, plan_id, pid, seq, ttype, ttype, status, opens, (T1 + dt.timedelta(days=21)).isoformat(), rem,
                     T0.isoformat(), occ])
        con.execute("""INSERT INTO notifications (id, patient_id, plan_id, task_id, channel, created_sim, delivered_sim)
                       VALUES (?, ?, ?, ?, 'CHW', ?, ?)""", [f"N-{tid}", pid, plan_id, tid, T0.isoformat(), T0.isoformat()])
    con.commit()
    con.close()


def _adapter(tmp_path, name, when=T0):
    (tmp_path / "sim_state.json").write_text('{"sim_time": "%s"}' % when.isoformat())
    return ParquetEMR(root=tmp_path / name, sim_state_dir=tmp_path)


def _quiet(*_):
    pass


# ---------------------------------------------------------------------------------------------------- #3 + no duplicates
def test_world_acts_on_the_opening_day_and_never_twice(tmp_path, healthy):
    """Tasks that open at 23:59:59 on the last day of the window: the world acts in clinic hours that day, and the
    engine's evidence rule accepts those rows. A task the world acted on is not acted on again in the next tick."""
    pids = healthy[:8]
    tasks = [(f"CT-{i:08X}", f"CP-{i:08X}", int(p), 1, "CHW_VISIT", "DUE", T1.isoformat(), 2, None) for i, p in enumerate(pids)]
    db = tmp_path / "care.sqlite"
    _db(db, tasks)
    ad = _adapter(tmp_path, "wb")
    out = care_world.step(T0, T1, adapter=ad, care_db=db, seed=5, log=_quiet)
    done = [o for o in out["outcomes"] if o["status"] == "completed"]
    assert done, out["summary"]
    enc = ad.read("encounter")
    by_task = {t[0]: t for t in tasks}
    for o in done:
        assert o["date"] == T1.date().isoformat()
        row = enc.filter(pl.col("encounter_id") == o["evidence"]["id"]).row(0, named=True)
        assert row["encounter_datetime"] < T1       # earlier in the day than opens_at ...
        task = {"type": "CHW_VISIT", "opens_at": T1.isoformat(), "created_sim": T0.isoformat()}
        fact = {"table": "encounter", "id": row["encounter_id"], "kind": "enc", "code": 17, "date": row["encounter_datetime"]}
        assert evidence.find(task, [fact], set(), T1) is fact   # ... and still accepted as evidence
        assert by_task[o["task_id"]][2] == row["patient_id"]
    n_enc = enc.height
    out2 = care_world.step(T1, T2, adapter=ad, care_db=db, seed=5, log=_quiet)  # the engine did not close them (yet)
    assert out2["summary"].get("already_acted") == len(done)
    assert not {o["task_id"] for o in out2["outcomes"]} & {o["task_id"] for o in done}
    assert ad.read("encounter").filter(pl.col("patient_id").is_in([by_task[o["task_id"]][2] for o in done])).height == len(done)
    assert ad.read("encounter").height >= n_enc


# ---------------------------------------------------------------------------------------------------- #15 cycle number
def test_chemo_cycle_obs_is_the_cycle_number_not_the_plan_seq(tmp_path, healthy):
    pid = int(healthy[0])
    tasks = [("CT-A0000001", "CP-C0000001", pid, 3, "MDT_PLAN", "COMPLETED", T0.isoformat(), 0, None),
             ("CT-A0000002", "CP-C0000001", pid, 5, "CHEMO_CYCLE", "COMPLETED", T0.isoformat(), 0, None),
             ("CT-A0000003", "CP-C0000001", pid, 7, "CHEMO_CYCLE", "DUE", T0.isoformat(), 2, None)]
    db = tmp_path / "care.sqlite"
    _db(db, tasks, {"pathway": "ONCOLOGY_TREATMENT"})
    ad = _adapter(tmp_path, "wb")
    out = care_world.step(T0, T1, adapter=ad, care_db=db, seed=11, log=_quiet)
    assert [o["task_id"] for o in out["outcomes"] if o["status"] == "completed"] == ["CT-A0000003"], out["summary"]
    cyc = ad.read("obs").filter(pl.col("concept_id") == C.CHEMO_CYCLE)["value_numeric"].to_list()
    assert cyc == [2.0]   # the second cycle of the plan (seq 7 before the fix)


# ---------------------------------------------------------------------------------------------------- #10 declines
def test_decline_draw_is_per_attempt(tmp_path, healthy, monkeypatch):
    cfg = care_world._cfg()
    monkeypatch.setattr(care_world, "_cfg", lambda: {**cfg, "decline_prob": {"default": 0.5}})
    pid = int(healthy[1])
    seen = []
    for attempt in range(8):
        db = tmp_path / f"c{attempt}.sqlite"
        _db(db, [("CT-D0000001", "CP-D0000001", pid, 1, "HB_RECHECK", "NOTIFIED", T0.isoformat(), attempt, None)])
        out = care_world.step(T0, T1, adapter=_adapter(tmp_path, f"wb{attempt}"), care_db=db, seed=3, log=_quiet)
        dec = [o for o in out["outcomes"] if o["status"] == "declined"]
        seen.append(bool(dec))
        if dec:
            assert dec[0]["attempt"] == attempt and dec[0]["reason"]
    assert any(seen) and not all(seen)   # keyed by task only, every attempt had the same answer


# ---------------------------------------------------------------------------------------------------- #16 repeatable
def test_outcomes_do_not_depend_on_random_task_ids(tmp_path, healthy):
    pids = healthy[2:7]

    def run(prefix, name):
        tasks = [(f"{prefix}-{i}", f"CP-{prefix}{i}", int(p), 1, t, "NOTIFIED", T0.isoformat(), 1, None)
                 for i, (p, t) in enumerate(zip(pids, ["HB_RECHECK", "HP_TEST", "FOLLOWUP_VISIT", "B12_CHECK", "CHW_VISIT"]))]
        db = tmp_path / f"{name}.sqlite"
        _db(db, tasks)
        ad = _adapter(tmp_path, name)
        out = care_world.step(T0, T1, adapter=ad, care_db=db, seed=9, log=_quiet)
        return sorted((o["patient_id"], o["status"], o["day"], o.get("result")) for o in out["outcomes"]), ad

    a, ad_a = run("CT-X", "a")
    b, ad_b = run("CT-Y", "b")
    assert a == b and a
    cols = ["patient_id", "encounter_type", "encounter_datetime", "uuid"]
    assert ad_a.read("encounter").select(cols).sort(cols).equals(ad_b.read("encounter").select(cols).sort(cols))


# ---------------------------------------------------------------------------------------------------- sim clock
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


def test_failed_advance_releases_the_progress_flag_and_lock(world, monkeypatch):
    local, ad, _ = world

    def boom(*a, **k):
        raise RuntimeError("disk full (test)")

    monkeypatch.setattr(local, "replay_raw", boom)
    with pytest.raises(RuntimeError):
        local.advance(1, run_pipeline=False, care_world=False, log=_quiet)
    prog = json.load(open(config.SIM_STATE_DIR / "advance_progress.json"))
    assert prog["running"] is False and "disk full" in prog["error"]
    assert local.status()["running_job"] is None and local.lock_free()
    # a stale running=true (e.g. a crash before this fix) with a free lock is not reported as running either
    prog.update(running=True)
    json.dump(prog, open(config.SIM_STATE_DIR / "advance_progress.json", "w"))
    assert local.status()["running_job"] is None
    monkeypatch.undo()


def test_model_jobs_and_advances_share_one_lock(world):
    local, _, _ = world
    lk = local.acquire("models: promote")
    try:
        with pytest.raises(local.BusyError, match="models: promote"):
            local.advance(1, run_pipeline=False, care_world=False, log=_quiet)
        with pytest.raises(local.BusyError):
            local.acquire("models: retrain")
        assert not local.lock_free()
    finally:
        lk.release()
    assert local.lock_free()
    assert local.advance(1, run_pipeline=False, care_world=False, log=_quiet)["status"] == "done"


def test_supersede_in_the_same_tick_leaves_one_diagnosis(world, monkeypatch):
    """A care-driven endoscopy before the patient's original diagnosis, both inside one tick: the original diagnosis
    rows replayed in that tick must be dropped (before the fix both courses were written)."""
    local, ad, fut = world
    p = LATENT_DIR / "gastric_cases.parquet"
    if "stage_months" not in pl.read_parquet_schema(p):
        pytest.skip("needs a v3-generated dataset")
    t0 = local.sim_time()
    days = 60
    t1 = t0 + dt.timedelta(days=days)
    d0, d1 = (t0.date() - dt.date(1970, 1, 1)).days, (t1.date() - dt.date(1970, 1, 1)).days
    cases = pl.read_parquet(p).filter(pl.col("dx_day").is_between(d0 + 15, d1 - 25) & (pl.col("onset_day") < pl.col("dx_day") - 60)
                                      & (pl.col("death_day").is_null() | (pl.col("death_day") > pl.col("dx_day") + 30)))
    stage_obs = (pl.scan_parquet(fut / "obs.parquet").filter(pl.col("concept_id") == C.STAGE_GROUP)
                 .filter((pl.col("obs_datetime") > t0) & (pl.col("obs_datetime") <= t1))
                 .filter(pl.col("person_id").is_in(cases["person_id"].implode())).collect())
    if stage_obs.height == 0:
        pytest.skip("no latent cancer with an original diagnosis inside the first 60 sim days")
    pid = int(stage_obs["person_id"][0])
    case = cases.filter(pl.col("person_id") == pid).row(0, named=True)
    endo_day = int(case["dx_day"]) - 10

    from generator import intervention as iv

    def fake_step(a, b, *, adapter=None, seed=None, log=print, replayed=None, care_db=None):
        rows, upd = iv.resimulate_from_endoscopy(pid, endo_day, 1001, seed=7, sim_time=a, adapter=adapter)
        assert upd["resimulated"]
        res = iv.commit(rows, upd, b, adapter=adapter)
        return {"rows": res["written"], "outcomes": [], "summary": {}}

    monkeypatch.setattr(care_world, "step", fake_step)
    local.advance(days, run_pipeline=False, care_world=True, log=_quiet)
    obs = ad.read("obs").filter((pl.col("person_id") == pid) & (pl.col("concept_id") == C.STAGE_GROUP))
    dfr = ad.deferred().get("obs")
    later = dfr.filter((pl.col("person_id") == pid) & (pl.col("concept_id") == C.STAGE_GROUP)).collect() if dfr is not None else obs.head(0)
    assert obs.height + later.height == 1, (obs.height, later.height)
    assert (obs["obs_id"] >= emr.CARE_ID_BASE).all()
    enc = ad.read("encounter").filter(pl.col("patient_id") == pid)
    endo_t = dt.datetime(1970, 1, 1) + dt.timedelta(days=endo_day)
    assert (enc.filter(pl.col("encounter_datetime") >= endo_t)["encounter_id"] >= emr.CARE_ID_BASE).all()
