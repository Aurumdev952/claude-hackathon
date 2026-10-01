"""External synthetic sources (generator/external): coherence with the EMR model, coverage, CIs, refs loading."""
import duckdb
import numpy as np
import polars as pl
import pytest

from shared.config import load_yaml
from shared.geo import WHO_STD

W = np.array(WHO_STD, float) / sum(WHO_STD)


@pytest.fixture(scope="module")
def ext(tmp_path_factory):
    from generator.external.__main__ import build_all
    out = tmp_path_factory.mktemp("external")
    info = build_all(out, log=lambda *_: None)
    return out, info, {n: pl.read_parquet(out / f"{n}.parquet") for n in
                       ("registry_incidence", "risk_factor_surveys", "population_projections")}


def _asr(df: pl.DataFrame) -> float:
    """Completeness-adjusted ASR per 100k (WHO world) from registry rows."""
    g = (df.group_by("age_band").agg((pl.col("cases") / pl.col("completeness")).sum().alias("c"),
                                     pl.col("population").sum().alias("p")).sort("age_band"))
    return float(((g["c"] / g["p"]).to_numpy() * W).sum() * 1e5)


def test_coverage_and_labels(ext):
    _, _, F = ext
    reg, sur, pop = F["registry_incidence"], F["risk_factor_surveys"], F["population_projections"]
    assert (reg["year"].min(), reg["year"].max()) == (2000, 2026)
    assert (pop["year"].min(), pop["year"].max()) == (2000, 2035)
    bands = sorted(pop["age_band"].unique())
    assert len(bands) == 18 and bands[0] == "00-04" and bands[-1] == "85+"
    assert reg["district_code"].n_unique() == 30 and set(reg["sex"]) == {"M", "F"}
    assert set(pop.filter(pl.col("year") >= 2026)["kind"]) == {"projection"}
    assert set(pop.filter(pl.col("year") <= 2025)["kind"]) == {"estimate"}
    for df in F.values():
        assert df["source_note"].str.contains("(Synthetic)", literal=True).all()
    for c in ("cases", "completeness", "morphology_intestinal_pct", "stage_I_pct", "stage_IV_pct"):
        assert c in reg.columns
    assert set(sur["age_band"]) == {"15-29", "30-49", "50+"}
    assert set(sur["indicator"]) == {"hp_seroprev", "smoking_current", "high_salt", "alcohol_any", "smoked_food"}


def test_registry_asr_matches_emr_calibration(ext):
    """D-03/D-33: the EMR is calibrated to a diagnosed-case ASR of ~34 per 100k (2024)."""
    _, _, F = ext
    reg = F["registry_incidence"]
    target = load_yaml("generator.yaml")["gastric_cancer"]["calibration"]["target_asr_2024"]
    by_year = [_asr(reg.filter(pl.col("year") == y)) for y in range(2015, 2026)]
    assert 0.8 * target <= np.mean(by_year) <= 1.1 * target, by_year
    assert abs(_asr(reg.filter(pl.col("year").is_between(2023, 2025))) - target) / target < 0.12
    # registry completeness ramp: captured share 40% -> 85%
    comp = dict(reg.group_by("year").agg(pl.col("completeness").first()).iter_rows())
    assert comp[2000] == pytest.approx(0.40) and comp[2015] == pytest.approx(0.85) and comp[2026] == pytest.approx(0.85)
    # national scale: thousands of cases a year, not the 0.1 EMR sample
    assert reg.filter(pl.col("year") == 2024)["cases"].sum() > 1500


def test_hotspots_and_young_onset_rise(ext):
    _, _, F = ext
    reg = F["registry_incidence"].filter(pl.col("year").is_between(2015, 2025))
    hot = load_yaml("generator.yaml")["insights"]["ins1"]["districts"]
    r_hot = _asr(reg.filter(pl.col("district_code").is_in(hot)))
    r_rest = _asr(reg.filter(~pl.col("district_code").is_in(hot)))
    assert r_hot / r_rest > 2.0, (r_hot, r_rest)
    for d in hot:  # every hotspot district is above the national rate
        assert _asr(reg.filter(pl.col("district_code") == d)) > _asr(reg)
    young = (F["registry_incidence"].filter(pl.col("age_band") < "50")
             .group_by("year").agg((pl.col("cases") / pl.col("completeness")).sum() / pl.col("population").sum())
             .sort("year"))
    early = young.filter(pl.col("year").is_between(2010, 2015))["cases"].mean()
    late = young.filter(pl.col("year").is_between(2021, 2026))["cases"].mean()
    assert late > 1.3 * early  # INS-2: young-onset rise


def test_population_projection_smooth(ext):
    _, _, F = ext
    tot = F["population_projections"].group_by("year").agg(pl.col("population").sum()).sort("year")["population"]
    g = np.diff(np.log(tot.to_numpy()))
    assert np.all(g > 0.005) and np.all(g < 0.04), g
    assert np.max(np.abs(np.diff(g[-12:]))) < 0.004  # projections: growth changes slowly, no jumps
    anchors = load_yaml("external.yaml")["population"]["anchors"]
    for y, v in anchors.items():
        assert abs(tot[int(y) - 2000] - v) / v < 0.001
    old = (F["population_projections"].filter(pl.col("age_band") >= "65").group_by("year")
           .agg(pl.col("population").sum()).sort("year")["population"])
    assert old[35] > old[25] > old[15]  # ageing


def test_surveys_cis(ext):
    _, _, F = ext
    s = F["risk_factor_surveys"]
    assert (s["lo95"] <= s["value"]).all() and (s["value"] <= s["hi95"]).all() and (s["n"] >= 30).all()
    assert s["survey"].n_unique() >= 5
    hp = s.filter(pl.col("indicator") == "hp_seroprev").group_by("year").agg(pl.col("value").mean()).sort("year")
    assert hp["value"][0] > hp["value"][-1]  # H. pylori declines across cohorts
    smk = s.filter(pl.col("indicator") == "smoking_current")
    assert smk.filter(pl.col("sex") == "M")["value"].mean() > 3 * smk.filter(pl.col("sex") == "F")["value"].mean()


def test_deterministic_and_refs_load(ext, tmp_path):
    from generator.external.__main__ import build_all
    from pipeline.refs import load_external
    out, info, F = ext
    build_all(tmp_path, log=lambda *_: None)
    assert pl.read_parquet(tmp_path / "registry_incidence.parquet").equals(F["registry_incidence"])
    con = duckdb.connect()
    assert load_external(con, out) == ["ext_registry", "ext_surveys", "ext_population"]
    assert con.execute("SELECT count(*) FROM ext_population").fetchone()[0] == F["population_projections"].height
    assert load_external(con, tmp_path / "missing") == []  # missing files are skipped
