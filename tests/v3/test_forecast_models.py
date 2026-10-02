"""Forecasting (track L3): incidence ensemble, drivers, scenarios, backtests and the forecast API on a small synthetic
registry fixture that follows the ext_* contract schema (docs/contracts/v3-loop.md §6). Everything here is synthetic."""
from __future__ import annotations

import copy
import datetime as dt
import time

import duckdb
import numpy as np
import pandas as pd
import pytest

from shared.config import load_yaml
from shared.geo import DISTRICT_CODES, DISTRICTS

SIM = dt.datetime(2026, 6, 30, 23, 59, 59)
BANDS = [f"{5 * i:02d}-{5 * i + 4:02d}" for i in range(17)] + ["85+"]


def _fixture_frames(seed: int = 7):
    rng = np.random.default_rng(seed)
    prov_hp = {"KGL": 0.55, "NOR": 0.75, "SOU": 0.65, "EAS": 0.6, "WES": 0.72}
    pyramid = np.array([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3.4, 2.8, 2.2, 1.6, 1.1, 0.7, 0.4]) / 100
    pop_rows, reg_rows = [], []
    for d in DISTRICT_CODES:
        prov = DISTRICTS[d][0]
        size = 350_000 * DISTRICTS[d][2] / 0.033
        rr_d = (1 + prov_hp[prov] * 2.0) / 2.3 * rng.lognormal(0, 0.1)
        for y in range(2000, 2036):
            shift = np.linspace(-0.004, 0.004, 18) * (y - 2000)          # slow ageing
            share = np.clip(pyramid + shift * pyramid, 1e-4, None)
            share /= share.sum()
            tot = size * 1.025 ** (y - 2000)
            for s in ("M", "F"):
                for a in range(18):
                    pop = tot * share[a] / 2
                    pop_rows.append({"year": y, "district_code": d, "sex": s, "age_band": BANDS[a], "population": pop,
                                     "kind": "estimate" if y <= 2025 else "projection", "source_note": "(Synthetic)"})
                    if y > 2025:
                        continue
                    age = 5 * a + 2.5
                    rate = 2.2e-5 * np.exp(0.075 * (age - 60)) * (2.0 if s == "M" else 1.0) * rr_d * 1.012 ** (y - 2000)
                    comp = min(0.85, 0.4 + 0.03 * (y - 2000))
                    reg_rows.append({"year": y, "district_code": d, "sex": s, "age_band": BANDS[a],
                                     "cases": int(rng.poisson(rate * pop * comp)), "completeness": comp,
                                     "morphology_intestinal_pct": 0.6, "stage_i_pct": 0.1, "stage_ii_pct": 0.15,
                                     "stage_iii_pct": 0.3, "stage_iv_pct": 0.45, "source_note": "(Synthetic)"})
    srv = []
    for sv, y in (("DHS-2005", 2005), ("DHS-2010", 2010), ("DHS-2015", 2015), ("DHS-2020", 2020), ("DHS-2025", 2025)):
        for p, hp in prov_hp.items():
            for s in ("M", "F"):
                for ab in ("15-29", "30-49", "50+"):
                    for ind, v in (("hp_seroprev", hp - 0.006 * (y - 2005)), ("smoking_current", (0.2 if s == "M" else 0.04) - 0.003 * (y - 2005)),
                                   ("high_salt", 0.4)):
                        v = float(np.clip(v + rng.normal(0, 0.01), 0.01, 0.99))
                        srv.append({"survey": sv, "year": y, "province_code": p, "sex": s, "age_band": ab, "indicator": ind,
                                    "value": v, "lo95": max(0.001, v - 0.04), "hi95": min(0.999, v + 0.04), "n": 400,
                                    "source_note": "(Synthetic)"})
    return pd.DataFrame(reg_rows), pd.DataFrame(pop_rows), pd.DataFrame(srv)


def _cfg():
    c = copy.deepcopy(load_yaml("forecast.yaml"))
    c["draws"] = 400
    c["backtest"]["draws"] = 300
    return c


@pytest.fixture(scope="module")
def fc(tmp_path_factory):
    from ml.forecast.run import run
    from pipeline.marts.forecast import build_forecast
    path = tmp_path_factory.mktemp("fc") / "work.duckdb"
    con = duckdb.connect(str(path))
    reg, pop, srv = _fixture_frames()
    for name, df in (("ext_registry", reg), ("ext_population", pop), ("ext_surveys", srv)):
        con.register("_x", df)
        con.execute(f"CREATE TABLE {name} AS SELECT * FROM _x")
        con.unregister("_x")
    c = _cfg()
    t = time.time()
    out = run(con, SIM, log=lambda *_: None, c=c)
    out["fit_seconds"] = time.time() - t
    build_forecast(con, SIM, log=lambda *_: None)
    yield {"con": con, "out": out, "cfg": c, "path": path}
    con.close()


def test_registry_source_and_horizon(fc):
    con = fc["con"]
    assert fc["out"]["source"] == "registry"
    yrs = [r[0] for r in con.execute("""SELECT DISTINCT year(period) FROM mart_forecast WHERE kind = 'forecast' AND freq = 'Y'
                                        AND series_id = 'NATIONAL|ALL|ALL|REGISTRY' ORDER BY 1""").fetchall()]
    assert yrs == list(range(2026, 2032))
    n = con.execute("SELECT count(DISTINCT series_id) FROM mart_forecast WHERE geo_level = 'DISTRICT'").fetchone()[0]
    assert n == 30


def test_intervals_nested(fc):
    """95% bands contain the 80% bands, which contain the mean, for every forecast row."""
    bad = fc["con"].execute("""SELECT count(*) FROM mart_forecast WHERE kind = 'forecast' AND freq = 'Y'
                               AND NOT (lo95 <= lo80 AND lo80 <= mean AND mean <= hi80 AND hi80 <= hi95)""").fetchone()[0]
    assert bad == 0
    rows = fc["con"].execute("SELECT count(*) FROM mart_forecast WHERE kind = 'forecast' AND freq = 'Y'").fetchone()[0]
    assert rows > 300


def test_forecast_tracks_truth(fc):
    """The fixture's true trend is +1.2%/yr with population growth: 2031 national cases exceed 2025."""
    con = fc["con"]
    last = con.execute("""SELECT mean FROM mart_forecast WHERE series_id = 'NATIONAL|ALL|ALL|REGISTRY' AND metric = 'cases'
                          AND kind = 'history' ORDER BY period DESC LIMIT 1""").fetchone()[0]
    f31 = con.execute("""SELECT mean, lo95, hi95 FROM mart_forecast WHERE series_id = 'NATIONAL|ALL|ALL|REGISTRY' AND metric = 'cases'
                         AND kind = 'forecast' AND year(period) = 2031""").fetchone()
    assert f31[0] > last
    assert f31[1] < f31[0] < f31[2]


def test_decomposition_sums_to_total(fc):
    from ml.forecast.drivers import das_gupta
    rng = np.random.default_rng(1)
    for _ in range(20):
        p1, p2 = rng.uniform(10, 1e5, 36), rng.uniform(10, 1e5, 36)
        r1, r2 = rng.uniform(0, 1e-3, 36), rng.uniform(0, 1e-3, 36)
        d = das_gupta(p1, r1, p2, r2)
        assert d["population"] + d["ageing"] + d["risk"] == pytest.approx(d["total"], rel=1e-9, abs=1e-9)
        assert d["total"] == pytest.approx(np.sum(p2 * r2) - np.sum(p1 * r1))
    rows = fc["con"].execute("""SELECT geo_code, sum(cases) AS s, any_value(total_change) AS t, any_value(cases_to - cases_from) AS t2
                                FROM mart_forecast_drivers GROUP BY 1""").df()
    assert len(rows) == 36
    assert np.allclose(rows["s"], rows["t"], atol=1e-6) and np.allclose(rows["t"], rows["t2"], atol=1e-6)
    nat = fc["con"].execute("SELECT component, cases FROM mart_forecast_drivers WHERE geo_code = 'RW'").df().set_index("component")["cases"]
    assert nat["population"] > 0 and nat["ageing"] > 0   # growing, ageing population in the fixture


def test_backtest_coverage_reported(fc):
    bt = fc["con"].execute("SELECT * FROM ml_forecast_backtest").df()
    assert set(bt["origin_year"]) == {2015, 2018, 2021}
    assert bt["horizon"].max() == 5
    assert bt[["mape", "cov80", "cov95", "crps"]].notna().all().all()
    s = fc["out"]["backtest"]
    assert s["n"] == len(bt) and 0.0 <= s["cov95"] <= 1.0
    assert s["cov95"] >= s["cov80"]
    assert s["cov95"] >= 0.6, f"95% interval coverage too low on the fixture: {s}"


def _base(con):
    """The scenario arrays exactly as the API builds them."""
    b = con.execute("SELECT * FROM ml_forecast_scenario_base ORDER BY district_code, year").df()
    coef = {r.term: (r.value, r.se) for r in con.execute("SELECT term, value, se FROM ml_forecast_coef").df().itertuples()}
    nat = con.execute("""SELECT year(period) AS year, mean, lo95, hi95 FROM mart_forecast WHERE series_id = 'NATIONAL|ALL|ALL|REGISTRY'
                         AND metric = 'cases' AND kind = 'forecast' ORDER BY period""").df()
    dists = sorted(b["district_code"].unique())
    B = b.pivot(index="district_code", columns="year", values="mean").loc[dists, nat["year"]].values
    first = b.drop_duplicates("district_code").set_index("district_code").loc[dists]
    return {"years": nat["year"].tolist(), "districts": dists, "B": B, "hp": first["hp"].tolist(), "smoking": first["smoking"].tolist(),
            "salt": first["salt"].tolist(), "early": first["early_share"].tolist(), "access": first["has_access"].tolist(),
            "sim_year": int(first["sim_year"].iloc[0]), "national": {k: nat[k].tolist() for k in ("mean", "lo95", "hi95")},
            "coef": {k: coef[k] for k in ("hp", "smoking", "salt", "access_early")}}


def test_scenario_hp_coverage_reduces_cases(fc):
    from ml.forecast.scenario import evaluate
    base = _base(fc["con"])
    zero = evaluate(base, {"hp_coverage_delta": 0.0, "until": 2031}, fc["cfg"])
    assert zero["cases_averted"] == pytest.approx(0.0, abs=1e-9)
    s = evaluate(base, {"hp_coverage_delta": 0.5, "until": 2031}, fc["cfg"])
    assert s["cases_averted"] > 0
    assert sum(x["mean"] for x in s["scenario"]) < sum(x["mean"] for x in s["baseline"])
    assert all(x["mean"] <= y["mean"] + 1e-9 for x, y in zip(s["scenario"], s["baseline"]))
    more = evaluate(base, {"hp_coverage_delta": 0.9, "until": 2031}, fc["cfg"])
    assert more["cases_averted"] > s["cases_averted"]
    smk = evaluate(base, {"smoking_delta": -0.3, "until": 2031}, fc["cfg"])
    assert smk["cases_averted"] > 0
    acc = evaluate(base, {"endoscopy_access": ["SOU-NYG", "WES-RUS"], "until": 2031}, fc["cfg"])
    assert acc["stage_shift"]["early_pct_scenario"] > acc["stage_shift"]["early_pct_baseline"]
    assert any("ssociational" in a for a in s["assumptions"]) and any("ynthetic" in a for a in s["assumptions"])


# ------------------------------------------------------------------------------------------------ API
@pytest.fixture(scope="module")
def api(fc):
    from fastapi.testclient import TestClient

    from api.deps import SERVE
    from api.main import app
    saved = (SERVE._con, SERVE.current, SERVE._cache)
    # serve a read-only copy of the fixture DB (the live serve DB is never touched)
    serve = str(fc["path"]) + ".serve.duckdb"
    con = fc["con"]
    con.execute(f"ATTACH '{serve}' AS s2")
    for (t,) in con.execute("""SELECT table_name FROM information_schema.tables WHERE table_catalog = current_database()
                               AND table_schema = 'main'""").fetchall():
        con.execute(f"CREATE TABLE s2.{t} AS SELECT * FROM main.{t}")
    con.execute("DETACH s2")
    SERVE._con = duckdb.connect(serve, read_only=True)
    SERVE.current, SERVE._cache = {"run_id": -1, "active": "test", "sim_time": SIM.isoformat()}, {}
    yield TestClient(app)
    SERVE._con.close()
    SERVE._con, SERVE.current, SERVE._cache = saved


def test_api_ministry_only(api):
    r = api.get("/api/v1/forecast/series", headers={"X-Role": "doctor", "X-Facility-Id": "1"})
    assert r.status_code == 403
    r = api.post("/api/v1/forecast/scenario", json={"hp_coverage_delta": 0.5}, headers={"X-Role": "doctor", "X-Facility-Id": "1"})
    assert r.status_code == 403


def test_api_series_drivers_map_backtest(api):
    r = api.get("/api/v1/forecast/series?geo=NATIONAL")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["series_id"] == "NATIONAL|ALL|ALL|REGISTRY" and len(d["forecast"]) == 6 and d["history"]
    assert d["backtest"]["cov95"] is not None
    comp = [h["completeness"] for h in d["history"]]          # registry completeness per history year (U2, additive)
    assert len(comp) == len(d["history"]) and all(0 < c <= 1 for c in comp)
    r = api.get("/api/v1/forecast/series?geo=DISTRICT&code=NOR-MUS&metric=asr")
    assert r.status_code == 200
    r = api.get("/api/v1/forecast/drivers?geo=NATIONAL").json()["data"]
    assert sum(c["cases"] for c in r["components"]) == pytest.approx(r["total_change"], abs=1e-6)
    m = api.get("/api/v1/forecast/map?year=2031&metric=change").json()["data"]
    assert len(m) == 30
    b = api.get("/api/v1/forecast/backtest").json()["data"]
    assert b["summary"]["n"] > 0 and set(b["summary"]["origins"]) == {2015, 2018, 2021}
    assert isinstance(b["tracking"], list)
    rf = api.get("/api/v1/forecast/risk-factors?indicator=hp_seroprev").json()["data"]
    assert rf and rf[0]["survey"] and rf[0]["forecast"]


def test_api_scenario_fast_and_consistent(api):
    body = {"hp_coverage_delta": 0.5, "smoking_delta": 0, "salt_delta": 0, "endoscopy_access": ["WES-RUS"], "until": 2031}
    r = api.post("/api/v1/forecast/scenario", json=body)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["cases_averted"] > 0
    assert d["stage_shift"]["early_pct_scenario"] >= d["stage_shift"]["early_pct_baseline"]
    times = []
    for k in range(10):
        t = time.perf_counter()
        r = api.post("/api/v1/forecast/scenario", json={**body, "hp_coverage_delta": 0.1 * k})
        times.append(time.perf_counter() - t)
        assert r.status_code == 200
    assert max(times) < 0.3, f"scenario latency {max(times) * 1000:.0f} ms"
    assert api.post("/api/v1/forecast/scenario", json={"hp_coverage_delta": 2}).status_code == 422
    assert api.post("/api/v1/forecast/scenario", json={"endoscopy_access": ["XXX"]}).status_code == 400
