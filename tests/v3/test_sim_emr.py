"""EMR write-back adapter and EMRBuilder (docs/contracts/v3-loop.md §2). Writes only to a tmp directory."""
import datetime as dt

import polars as pl
import pytest

from care import emr
from care.emr_rows import EMRBuilder
from generator.writers import COLUMNS, SCHEMAS
from shared.concepts import C

SIM = dt.datetime(2026, 7, 10, 23, 59, 59)


@pytest.fixture()
def wb(tmp_path, monkeypatch):
    from shared import config
    monkeypatch.setattr(config, "BULK_DIR", tmp_path / "bulk")
    monkeypatch.setattr(config, "SIM_STATE_DIR", tmp_path / "sim_state")
    (tmp_path / "sim_state").mkdir()
    (tmp_path / "sim_state" / "sim_state.json").write_text('{"sim_time": "%s"}' % SIM.isoformat())
    monkeypatch.setenv("EMR_MODE", "local")
    return emr.get_adapter()


def _build(ad, pid=4242, loc=1201):
    b = EMRBuilder(adapter=ad)
    e = b.encounter(pid, SIM - dt.timedelta(hours=2), 15, loc)
    b.coded(e, C.CARE_PATHWAY, C.PW_ENDOSCOPY)
    b.text(e, C.CARE_TASK, "ENDOSCOPY")
    g = b.group(e, C.ENDO_SET)
    b.coded(e, C.RUT, C.NEG, group=g)
    b.num(e, C.B12, 312.4)
    o = b.order(e, C.ORD_ENDOSCOPY)
    d = b.drug(e, C.CYANOCOBALAMIN, 1)
    return b, e, o, d


def test_builder_frames_match_bulk_schema(wb):
    b, e, o, d = _build(wb)
    F = b.frames()
    for t in ("visit", "encounter", "obs", "orders", "drug_order", "patient_program"):
        assert dict(F[t].schema) == SCHEMAS[t], t
        assert F[t].columns == COLUMNS[t]
    enc = F["encounter"].row(0, named=True)
    assert enc["encounter_id"] == e > emr.CARE_ID_BASE and enc["encounter_type"] == 15 and enc["creator"] == 2
    assert enc["date_created"] == SIM.replace(microsecond=0) and enc["visit_id"] > emr.CARE_ID_BASE
    obs = F["obs"]
    assert obs.height == 5 and set(obs["person_id"]) == {4242} and set(obs["encounter_id"]) == {e}
    assert obs.filter(pl.col("concept_id") == C.RUT)["obs_group_id"].item() == obs.filter(
        pl.col("concept_id") == C.ENDO_SET)["obs_id"].item()
    assert obs.filter(pl.col("concept_id") == C.CARE_TASK)["value_text"].item() == "ENDOSCOPY"
    assert set(obs["status"]) == {"FINAL"} and obs["uuid"].n_unique() == 5
    assert set(F["orders"]["order_id"]) == {o, d} and F["drug_order"]["order_id"].to_list() == [d]
    assert F["drug_order"]["drug_inventory_id"].item() == 18


def test_write_parts_state_and_ids(wb):
    b, e, *_ = _build(wb)
    counts = b.write("t1")
    assert counts["encounter"] == 1 and counts["obs"] == 5 and counts["drug_order"] == 1
    assert [p.name for p in wb.parts("encounter")] == ["part-000001.parquet"]
    b2, e2, *_ = _build(wb, pid=4343)
    b2.write("t2")
    assert e2 > e
    enc = wb.read("encounter")
    assert enc.height == 2 and enc["encounter_id"].n_unique() == 2
    ids = wb.next_ids("obs", 3)
    assert ids[0] > wb.read("obs")["obs_id"].max() and len(set(ids)) == 3
    # state.json lost -> counters recovered from the parts, never reusing ids
    (wb.root / "state.json").unlink()
    assert wb.next_ids("encounter", 1)[0] > enc["encounter_id"].max()


def test_conform_fills_missing_columns(wb):
    df = pl.DataFrame({"encounter_id": [emr.CARE_ID_BASE + 7], "encounter_type": [17], "patient_id": [1],
                       "location_id": [2001], "encounter_datetime": [SIM]})
    out = emr.conform("encounter", df, SIM)
    r = out.row(0, named=True)
    assert dict(out.schema) == SCHEMAS["encounter"]
    assert r["creator"] == 2 and r["voided"] == 0 and r["visit_id"] is None and r["date_created"] == SIM and r["uuid"]
    assert emr.conform("encounter", df, SIM)["uuid"].item() == r["uuid"]  # deterministic


def test_supersede_and_drop(wb):
    seq = wb.supersede(4242, 20650, "earlier endoscopy")
    sup = wb.superseded()
    assert seq == 1 and sup.columns[:4] == ["patient_id", "from_day", "reason", "at_sim_time"]
    assert sup.row(0, named=True)["at_sim_time"] == SIM
    t_before = dt.datetime(1970, 1, 1) + dt.timedelta(days=20649, hours=10)
    t_after = dt.datetime(1970, 1, 1) + dt.timedelta(days=20651, hours=10)
    rows = {"encounter": pl.DataFrame({"encounter_id": [1, 2, 3], "patient_id": [4242, 4242, 7],
                                       "encounter_datetime": [t_before, t_after, t_after]}),
            "obs": pl.DataFrame({"obs_id": [10, 11, 12], "encounter_id": [1, 2, 3]}),
            "orders": pl.DataFrame({"order_id": [20, 21], "encounter_id": [2, 3]}),
            "drug_order": pl.DataFrame({"order_id": [20, 21]}),
            "visit": pl.DataFrame({"visit_id": [5, 6], "patient_id": [4242, 4242], "date_started": [t_before, t_after]})}
    out = emr.drop_superseded(rows, sup)
    assert out["encounter"]["encounter_id"].to_list() == [1, 3]
    assert out["obs"]["obs_id"].to_list() == [10, 12]
    assert out["orders"]["order_id"].to_list() == [21] and out["drug_order"]["order_id"].to_list() == [21]
    assert out["visit"]["visit_id"].to_list() == [5]
    # rows created by that same supersede (re-simulated) are kept; a later supersede drops them
    resim = {"encounter": rows["encounter"].with_columns(pl.lit(1, pl.Int64).alias("_sup"))}
    assert emr.drop_superseded(resim, sup, "_sup")["encounter"].height == 3
    wb.supersede(4242, 20651, "second intervention")
    assert emr.drop_superseded(resim, wb.superseded(), "_sup")["encounter"]["encounter_id"].to_list() == [1, 3]


def test_window_and_deferred(wb):
    b, e, *_ = _build(wb)
    later = b.encounter(4242, SIM + dt.timedelta(days=20), 3, 1001)
    b.num(later, C.WEIGHT, 61.2)
    F = b.frames()
    now = emr.window(F, SIM - dt.timedelta(days=1), SIM)
    assert now["encounter"]["encounter_id"].to_list() == [e] and now["obs"].height == 5
    assert now["drug_order"].height == 1
    nxt = emr.window(F, SIM, SIM + dt.timedelta(days=30))
    assert nxt["encounter"]["encounter_id"].to_list() == [later] and nxt["obs"].height == 1
    assert nxt["encounter"]["date_created"].item() > SIM  # created when it happens, not at sim time
    wb.defer(nxt, sup_seq=3)
    d = {t: lf.collect() for t, lf in wb.deferred().items()}
    assert d["encounter"]["_sup"].to_list() == [3]
    assert emr.window(d, SIM, SIM + dt.timedelta(days=30))["obs"].height == 1


def test_log_tick(wb):
    assert wb.log_tick(SIM, 12, 80) == 1
    assert wb.log_tick(SIM + dt.timedelta(days=1), 3, 9) == 2
    log = wb.read("sim_tick_log")
    assert log["tick_id"].to_list() == [1, 2] and log.columns == ["tick_id", "sim_time", "wall_time",
                                                                   "encounters_added", "obs_added"]


def test_schemas_match_generated_bulk():
    from shared.config import BULK_DIR
    fut = BULK_DIR / "future"
    if not fut.exists():
        pytest.skip("no generated dataset")
    for t in SCHEMAS:
        assert dict(pl.read_parquet_schema(fut / f"{t}.parquet")) == SCHEMAS[t], t
