"""generator/intervention.py: an earlier, care-driven endoscopy re-simulates the latent cancer course.

Needs a dataset generated with the v3 generator (latent stage_months); writes only to a tmp writeback directory."""
import datetime as dt

import polars as pl
import pytest

from care import emr
from care.emr import ParquetEMR
from generator import intervention as iv
from generator.dates import d
from generator.diseases.gastric_cancer import STAGES
from shared.config import LATENT_DIR
from shared.concepts import C

SIM = dt.datetime(2026, 7, 1, 23, 59, 59)


@pytest.fixture(scope="module")
def cases():
    p = LATENT_DIR / "gastric_cases.parquet"
    if not p.exists():
        pytest.skip("no generated dataset")
    c = pl.read_parquet(p)
    if "stage_months" not in c.columns:
        pytest.skip("dataset predates the v3 generator (no latent stage_months); run make dev-data")
    return c


@pytest.fixture()
def ad(tmp_path):
    (tmp_path / "sim_state.json").write_text('{"sim_time": "%s"}' % SIM.isoformat())
    return ParquetEMR(root=tmp_path / "wb", sim_state_dir=tmp_path)


def _late(cases, n=12):
    return (cases.filter(pl.col("dx_day").is_not_null() & pl.col("stage").is_in(["III", "IV"])
                         & (pl.col("dx_day") - pl.col("onset_day") > 365) & (pl.col("dx_day") > d("2022-01-01")))
            .sort("person_id").head(n))


def test_earlier_endoscopy_earlier_stage_and_supersede(cases, ad):
    late = _late(cases)
    assert late.height >= 5
    better = 0
    for r in late.iter_rows(named=True):
        endo = r["dx_day"] - 200  # 6+ months earlier than the original diagnosis
        rows, upd = iv.resimulate_from_endoscopy(r["person_id"], endo, 1001, seed=11, adapter=ad, sim_time=SIM)
        assert upd["resimulated"] and upd["cancer_found"] and upd["status"] in ("CONFIRMED", "PROBABLE")
        assert STAGES.index(upd["stage"]) <= STAGES.index(r["stage"]), (r["person_id"], r["stage"], upd["stage"])
        assert upd["p_curative"] >= upd["original_p_curative"]
        better += upd["p_curative"] > upd["original_p_curative"]
        # the endoscopy happens on the intervention day at the chosen site, rows are in the care id range
        enc = rows["encounter"]
        endo_enc = enc.filter(pl.col("encounter_type") == 5)
        assert endo_enc.height >= 1 and endo_enc["location_id"][0] == 1001
        assert endo_enc["encounter_datetime"][0].date() == (dt.date(1970, 1, 1) + dt.timedelta(days=endo))
        assert enc["encounter_id"].min() > emr.CARE_ID_BASE and set(enc["patient_id"]) == {r["person_id"]}
        assert rows["obs"].filter(pl.col("concept_id") == C.STAGE_GROUP).height == 1
        sup = ad.superseded().filter(pl.col("patient_id") == r["person_id"])
        assert sup.height == 1 and sup["from_day"][0] == endo and upd["supersede_seq"] == sup["seq"][0]
    assert better >= 1


def test_commit_writes_now_and_defers_later(cases, ad):
    r = _late(cases, 1).row(0, named=True)
    endo = r["dx_day"] - 200
    t1 = dt.datetime(1970, 1, 1) + dt.timedelta(days=endo, hours=23, minutes=59, seconds=59)
    rows, upd = iv.resimulate_from_endoscopy(r["person_id"], endo, 1001, seed=3, adapter=ad, sim_time=SIM)
    out = iv.commit(rows, upd, t1, adapter=ad)
    assert out["written"]["encounter"] >= 1          # the endoscopy itself
    assert out["deferred"].get("encounter", 0) >= 1  # pathology, oncology, follow-up: replayed when due
    wrote = ad.read("encounter")
    assert (wrote["encounter_datetime"] <= t1).all()
    dfr = {t: lf.collect() for t, lf in ad.deferred().items()}
    assert (dfr["encounter"]["encounter_datetime"] > t1).all() and set(dfr["encounter"]["_sup"]) == {upd["supersede_seq"]}
    total = sum(df.height for df in rows.values())
    assert sum(out["written"].values()) + sum(out["deferred"].values()) == total
    log = iv.interventions(ad)
    assert log.height == 1 and log["stage"][0] == upd["stage"] and log["original_stage"][0] == r["stage"]


def test_deterministic(cases, ad):
    r = _late(cases, 1).row(0, named=True)
    a, ua = iv.resimulate_from_endoscopy(r["person_id"], r["dx_day"] - 250, 1001, seed=5, adapter=ad, sim_time=SIM,
                                         supersede=False)
    b, ub = iv.resimulate_from_endoscopy(r["person_id"], r["dx_day"] - 250, 1001, seed=5, adapter=ad, sim_time=SIM,
                                         supersede=False)
    assert ua["stage"] == ub["stage"] and ua["death_day"] == ub["death_day"]
    drop = ["obs_id", "encounter_id", "obs_group_id", "order_id", "uuid"]
    assert a["obs"].drop(drop).equals(b["obs"].drop(drop))


def test_no_latent_cancer_gives_benign_endoscopy(cases, ad):
    persons = pl.read_parquet(LATENT_DIR / "persons.parquet")
    adults = persons.filter(~pl.col("person_id").is_in(cases["person_id"].implode())
                            & (pl.col("birth_day") < d("1980-01-01")) & (pl.col("death_day") > d("2028-01-01")))
    for hp in (True, False):
        pr = adults.filter(pl.col("hp") == hp).row(0, named=True)
        rows, upd = iv.resimulate_from_endoscopy(pr["person_id"], d("2026-07-10"), 1201, seed=1, adapter=ad, sim_time=SIM)
        assert not upd["resimulated"] and not upd["cancer_found"] and upd["supersede_seq"] is None
        assert upd["finding"] in ("NORMAL", "GASTRITIS", "ATROPHY_IM", "INTESTINAL_METAPLASIA")
        rut = rows["obs"].filter(pl.col("concept_id") == C.RUT)["value_coded"].item()
        if not hp:
            assert rut == C.NEG
    assert ad.superseded().height == 0
