"""SPEC §19.2 realism checks on the generated dataset (tolerances widen for SCALE < 1, see docs/decisions.md D-08)."""
import json
import math

import numpy as np
import polars as pl
import pytest

from generator.dates import d
from shared.config import LATENT_DIR, REF_DIR
from shared.geo import PYRAMID

HIST_END = d("2026-06-30")


def widen(scale: float, base: float) -> float:
    """Sampling-noise widening: tolerance grows ~1/sqrt(scale)."""
    return base * max(1.0, math.sqrt(1.0 / scale))


@pytest.fixture(scope="module")
def cases():
    c = pl.read_parquet(LATENT_DIR / "gastric_cases.parquet")
    return c.filter(pl.col("dx_day").is_not_null() & (pl.col("dx_day") <= HIST_END) & (pl.col("dx_day") >= pl.col("emr_start")))


@pytest.fixture(scope="module")
def persons():
    return pl.read_parquet(LATENT_DIR / "persons.parquet")


def test_age_pyramid(persons):
    ref = d("2020-07-01")
    alive = persons.filter((pl.col("birth_day") <= ref) & (pl.col("death_day") > ref))
    age = (ref - alive["birth_day"].to_numpy()) / 365.25
    bins = np.clip(age // 5, 0, 16).astype(int)
    share = np.bincount(bins, minlength=17) / len(bins) * 100
    target = np.array(PYRAMID) / sum(PYRAMID) * 100
    assert np.all(np.abs(share - target) <= 2.0), list(zip(share.round(1), target.round(1)))


def test_gi_cohort_size(bulk_con, scale):
    n = bulk_con.sql(GI_COHORT_SQL).fetchone()[0]
    target = 50000 * scale
    assert abs(n - target) / target <= widen(scale, 0.05), (n, target)


def test_calibration_targets(cases, scale):
    confirmed = cases.filter(pl.col("status") == "CONFIRMED").height
    lo, hi = 2000 * scale, 3000 * scale
    tol = widen(scale, 0.05)
    assert lo * (1 - tol) <= confirmed <= hi * (1 + tol), confirmed
    probable_share = (cases["status"] == "PROBABLE").mean()
    assert 0.08 <= probable_share <= 0.17, probable_share
    st = cases["stage"].value_counts()
    iv = (cases["stage"] == "IV").mean() * 100
    early = cases["stage"].is_in(["I", "II"]).mean() * 100
    t = widen(scale, 2.0)
    assert 45 - t <= iv <= 55 + t, st
    assert 15 - t <= early <= 25 + t, st
    age = ((cases["dx_day"] - cases["birth_day"]) / 365.25).median()
    assert 58 - t / 2 <= age <= 62 + t / 2, age
    mf = cases["male"].sum() / (~cases["male"]).sum()
    assert 1.7 - 0.1 * t / 2 <= mf <= 2.0 + 0.1 * t / 2, mf
    lauren = cases["lauren"].value_counts(normalize=True)
    lz = {r[0]: r[1] * 100 for r in lauren.iter_rows()}
    assert abs(lz["intestinal"] - 65) <= 5 + t and abs(lz["diffuse"] - 28) <= 5 + t
    s1 = ((cases["death_day"].fill_null(10**7) - cases["dx_day"]) > 365).mean() * 100
    assert 30 - t <= s1 <= 40 + t, s1


def test_undiagnosed_share(scale):
    c = pl.read_parquet(LATENT_DIR / "gastric_cases.parquet").filter(pl.col("symptom_start_day") <= d("2025-01-01"))
    died = c.filter(pl.col("dx_day").is_null() & pl.col("death_day").is_not_null() & (pl.col("death_day") >= pl.col("symptom_start_day")))
    share = died.height / c.height * 100
    assert 3 <= share <= 10, share


def test_visit_rates_ordering(bulk_con):
    r = dict(bulk_con.sql("""
        select case when date_diff('year', p.birthdate, v.date_started) < 5 then 'u5'
                    when date_diff('year', p.birthdate, v.date_started) < 60 then 'adult' else 'elderly' end g,
               count(*) from visit v join person p on p.person_id = v.patient_id
        where v.date_started <= DATE '2026-06-30' group by 1""").fetchall())
    # per-person-year rates need denominators; relative ordering is the robust realism signal (D-05)
    pop = pl.read_csv(REF_DIR / "district_population.csv").filter(pl.col("year") <= 2025)
    def py(groups):
        return pop.filter(pl.col("age_group").is_in(groups))["population"].sum()
    u5 = r["u5"] / py(["0-4"])
    adult = r["adult"] / py(["5-9", "10-14", "15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54", "55-59"])
    eld = r["elderly"] / py(["60-64", "65-69", "70-74", "75-79", "80-84", "85+"])
    assert u5 > adult and eld > adult, (u5, adult, eld)
    assert 0.4 <= adult <= 3.0 and 1.0 <= eld <= 5.0 and 1.0 <= u5 <= 4.0, (u5, adult, eld)


def test_malaria_seasonality(bulk_con):
    rows = bulk_con.sql("""select month(obs_datetime) m, count(*) from obs where concept_id = 1000 and value_coded = 2100
                            and obs_datetime <= DATE '2026-06-30' group by 1""").fetchall()
    c = dict(rows)
    peak = max(c.get(m, 0) for m in (3, 4, 5, 10, 11, 12))
    trough = min(c.get(m, 0) for m in (1, 2, 6, 7, 8, 9))
    assert peak >= 1.5 * trough, c


def test_htn_followup_interval(bulk_con):
    med = bulk_con.sql("""with e as (select patient_id, encounter_datetime t,
                               lag(encounter_datetime) over (partition by patient_id order by encounter_datetime) p
                               from encounter where encounter_type = 13)
                          select median(date_diff('day', p, t)) from e where p is not null""").fetchone()[0]
    assert 30 <= med <= 92, med


def test_no_encounters_before_go_live(bulk_con):
    fac = pl.read_csv(REF_DIR / "facilities.csv").select("location_id", "go_live_date")
    bulk_con.register("fac", fac.to_arrow())
    n = bulk_con.sql("""select count(*) from encounter e join fac f on f.location_id = e.location_id
                        where e.encounter_datetime < cast(f.go_live_date as date)
                          and e.encounter_datetime >= DATE '2015-01-01'""").fetchone()[0]
    noise = json.load(open(LATENT_DIR / "noise_log.json"))["counts"]
    assert n <= noise.get("before_birth", 0) + 5, n  # only injected dating errors may violate it


def test_obs_before_birth_only_injected(bulk_con):
    n = bulk_con.sql("""select count(distinct e.encounter_id) from encounter e join person p on p.person_id = e.patient_id
                        where e.encounter_datetime < p.birthdate""").fetchone()[0]
    noise = json.load(open(LATENT_DIR / "noise_log.json"))["counts"]
    assert n <= noise.get("before_birth", 0) * 1.1 + 5, (n, noise)


def test_openmrs_ids_unique(bulk_con):
    dup = bulk_con.sql("select count(*) - count(distinct identifier || identifier_type) from patient_identifier").fetchone()[0]
    assert dup == 0


GI_COHORT_SQL = """
with dx as (select person_id, obs_datetime t, value_coded c from obs where concept_id = 1000 and voided = 0),
cc as (select person_id, obs_datetime t from obs where concept_id = 1003 and voided = 0
       and value_coded in (2200,2201,2202,2203,2204,2205,2206,2211,2212,2213)),
cc2 as (select a.person_id, min(b.t) t from cc a join cc b on a.person_id = b.person_id and b.t > a.t
        and b.t <= a.t + interval 365 day group by 1),
e as (
  select person_id from dx where c between 2010 and 2021
  union select person_id from cc2
  union select person_id from obs where concept_id in (3120,3121,3122,5006,5024)
  union select patient_id from orders where concept_id in (8001, 8000)
  union select patient_id from encounter where encounter_type = 5
  union select d.person_id from dx d join person p on p.person_id = d.person_id
        where d.c = 2022 and date_diff('year', p.birthdate, d.t) >= 40
  union select person_id from dx where c between 2000 and 2005)
select count(distinct person_id) from e
"""
