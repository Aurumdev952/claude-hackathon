"""simulator/care_world.py: open care tasks -> patient behaviour -> EMR rows (deterministic). Uses a care.sqlite with
the contract schema (§4.1) in a tmp dir and a tmp write-back; needs a v3-generated dataset for the latent truth."""
import datetime as dt
import sqlite3

import polars as pl
import pytest

from care import emr
from care.emr import ParquetEMR
from generator.dates import d
from shared.concepts import C
from shared.config import LATENT_DIR
from simulator import care_world

T0 = dt.datetime(2026, 7, 1, 23, 59, 59)
T1 = dt.datetime(2026, 7, 31, 23, 59, 59)
SCHEMA = """
CREATE TABLE care_plans (id TEXT PRIMARY KEY, patient_id INT, display_id TEXT, facility_id INT, pathway TEXT, status TEXT,
  source_alert_id TEXT, "trigger" TEXT, approved_by TEXT, approved_at TEXT, channels TEXT, model_id TEXT,
  risk_at_approval REAL, band_at_approval TEXT, propensity REAL, due_override TEXT, target_facility_id INT, note TEXT,
  emr_encounter_id INT, created_sim TEXT, closed_sim TEXT);
CREATE TABLE care_tasks (id TEXT PRIMARY KEY, plan_id TEXT, patient_id INT, seq INT, type TEXT, title TEXT, status TEXT,
  opens_at TEXT, due_at TEXT, completed_at TEXT, evidence TEXT, result TEXT, reminders INT, last_reminder_sim TEXT,
  escalation_level INT, created_sim TEXT);
CREATE TABLE notifications (id TEXT PRIMARY KEY, patient_id INT, plan_id TEXT, task_id TEXT, channel TEXT,
  template_key TEXT, title TEXT, body TEXT, created_sim TEXT, delivered_sim TEXT, read_sim TEXT, acted_sim TEXT);
"""


@pytest.fixture(scope="module")
def latent():
    p = LATENT_DIR / "gastric_cases.parquet"
    if not p.exists() or "stage_months" not in pl.read_parquet_schema(p):
        pytest.skip("needs a v3-generated dataset (latent stage_months)")
    cases = pl.read_parquet(p)
    persons = pl.read_parquet(LATENT_DIR / "persons.parquet")
    live = cases.filter((pl.col("onset_day") < d("2026-06-01")) & (pl.col("dx_day").is_null() | (pl.col("dx_day") > d("2026-09-01")))
                        & (pl.col("death_day").is_null() | (pl.col("death_day") > d("2026-10-01"))))
    healthy = persons.filter(~pl.col("person_id").is_in(cases["person_id"].implode()) & (pl.col("birth_day") < d("1975-01-01"))
                             & (pl.col("death_day") > d("2028-01-01")) & (pl.col("person_id") < 100_000))
    return live, healthy


def _care_db(path, tasks):
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for i, (pid, ttype, chans, reminders, fac) in enumerate(tasks):
        pl_id, t_id = f"CP-{i:08x}", f"CT-{i:08x}"
        con.execute("INSERT INTO care_plans (id, patient_id, facility_id, pathway, status, \"trigger\", channels, created_sim) "
                    "VALUES (?, ?, ?, 'TEST', 'ACTIVE', 'RISK_BAND_HIGH', ?, ?)", [pl_id, pid, fac, str(chans), T0.isoformat()])
        con.execute("INSERT INTO care_tasks (id, plan_id, patient_id, seq, type, title, status, opens_at, due_at, reminders, "
                    "escalation_level, created_sim) VALUES (?, ?, ?, 1, ?, ?, 'NOTIFIED', ?, ?, ?, 0, ?)",
                    [t_id, pl_id, pid, ttype, ttype, T0.isoformat(), (T0 + dt.timedelta(days=21)).isoformat(), reminders,
                     T0.isoformat()])
        for j, ch in enumerate(chans):
            con.execute("INSERT INTO notifications (id, patient_id, plan_id, task_id, channel, created_sim, delivered_sim) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)", [f"N-{i}-{j}", pid, pl_id, t_id, ch, T0.isoformat(), T0.isoformat()])
    con.commit()
    con.close()


def _adapter(tmp_path, name):
    (tmp_path / "sim_state.json").write_text('{"sim_time": "%s"}' % T0.isoformat())
    return ParquetEMR(root=tmp_path / name, sim_state_dir=tmp_path)


def test_no_care_db_does_nothing(tmp_path):
    out = care_world.step(T0, T1, adapter=_adapter(tmp_path, "wb"), care_db=tmp_path / "missing.sqlite", seed=1)
    assert out == {"rows": {}, "outcomes": [], "summary": {"open_tasks": 0}}


def _run(tmp_path, latent, name):
    live, healthy = latent
    cancer_pid = int(live["person_id"][0])
    hs = healthy["person_id"].to_list()
    tasks = [(cancer_pid, "ENDOSCOPY", ["APP", "SMS", "CHW"], 4, 1201)]
    tasks += [(int(hs[k]), t, ["SMS", "CHW"], 3, 1201) for k, t in
              enumerate(["HB_RECHECK", "HP_TEST", "CHW_VISIT", "FOLLOWUP_VISIT", "B12_CHECK", "HP_TREATMENT"])]
    db = tmp_path / f"{name}.sqlite"
    _care_db(db, tasks)
    ad = _adapter(tmp_path, name)
    return care_world.step(T0, T1, adapter=ad, care_db=db, seed=123), ad, cancer_pid


def test_tasks_become_emr_rows_and_are_deterministic(tmp_path, latent):
    out, ad, cancer_pid = _run(tmp_path, latent, "a")
    done = [o for o in out["outcomes"] if o["status"] == "completed"]
    assert len(done) >= 4, out["summary"]
    for o in done:
        assert T0.date() < dt.date.fromisoformat(o["date"]) <= T1.date() and o["evidence"]["id"] is not None
    enc = ad.read("encounter")
    assert enc.height >= len(done) and (enc["encounter_id"] > emr.CARE_ID_BASE).all()
    obs = ad.read("obs")
    by_type = {o["type"]: o for o in done}
    if "HB_RECHECK" in by_type:
        assert obs.filter(pl.col("concept_id") == C.HB).height >= 1
    if "CHW_VISIT" in by_type:
        assert enc.filter(pl.col("encounter_type") == 17).height == 1
    if "ENDOSCOPY" in by_type:  # latent cancer present: earlier diagnosis and a superseded future
        assert by_type["ENDOSCOPY"]["result"] == "CANCER_FOUND"
        assert ad.superseded()["patient_id"].to_list() == [cancer_pid]
        assert enc.filter(pl.col("encounter_type") == 5).height == 1
    assert out["rows"]["encounter"] == enc.height
    # same seed and sim window -> the same outcomes and rows
    out2, ad2, _ = _run(tmp_path, latent, "b")
    key = lambda xs: [(o["task_id"], o["status"], o["day"], o.get("result")) for o in xs]  # noqa: E731
    assert key(out["outcomes"]) == key(out2["outcomes"])
    cols = ["encounter_type", "patient_id", "location_id", "encounter_datetime"]
    assert ad.read("encounter").select(cols).sort(cols).equals(ad2.read("encounter").select(cols).sort(cols))


def test_adherence_model_directions(tmp_path, latent):
    _, healthy = latent
    w = care_world.World(T0, T1, _adapter(tmp_path, "w"), 7)
    pid = int(healthy["person_id"][0])
    p, _, _ = w.patient(pid)
    day = d("2026-07-10")
    task = {"id": "CT-x", "type": "HB_RECHECK", "patient_id": pid, "due_at": "2026-07-20T00:00:00", "reminders": 0}
    near = {"facility_id": p.home_at(day), "target_facility_id": p.home_at(day)}
    far_loc = max(w.ctx.by_id, key=lambda k: care_world._km(w.facility(p.home_at(day)), w.facility(k)) or 0)
    far = {"facility_id": far_loc, "target_facility_id": far_loc}
    base = w.p_day(task, near, p, day, [], 0)
    assert w.p_day(task, far, p, day, [], 0) < base                      # distance is a barrier
    sms = [{"channel": "SMS", "delivered_sim": "2026-07-02T08:00:00"}]
    chw = [{"channel": "CHW", "delivered_sim": "2026-07-02T08:00:00"}]
    assert base < w.p_day(task, near, p, day, sms, 0) < w.p_day(task, near, p, day, chw, 0)  # app < SMS < CHW
    assert w.p_day({**task, "reminders": 3}, near, p, day, [], 0) > base
    assert w.p_day(task, near, p, day, [], 6) > base                     # regular attenders come back
    late = d("2026-08-20")
    assert w.p_day(task, near, p, late, [], 0) < w.p_day(task, near, p, day, [], 0) * 1.01
