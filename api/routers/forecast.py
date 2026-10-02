"""Forecast endpoints (docs/contracts/v3-loop.md §7, track L3). Ministry only; aggregates with small-cell suppression.

All numbers are SYNTHETIC; scenario effects are associational. Heavy models are fitted offline (`make forecast`) and
published as mart_forecast*, ml_forecast_*; the scenario endpoint is closed form on cached arrays (< 300 ms).
"""
from __future__ import annotations

import json
import time

import numpy as np
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from shared.config import load_yaml
from shared.geo import DISTRICTS, PROVINCES

from ..deps import SERVE, APIError, Role, envelope, ministry, role

router = APIRouter()
LEVELS = ("NATIONAL", "PROVINCE", "DISTRICT")
SEX = ("ALL", "M", "F")
AGES = ("ALL", "<50", "50-64", "65+")
OPS_METRICS = ("gi_visits", "high_flags", "endoscopy_demand", "care_tasks", "endoscopy_capacity")
SYNTHETIC = "Synthetic data. Forecasts are model projections; covariate effects are associational, not causal."


def m(r: Role = Depends(role)) -> Role:
    return ministry(r)


def _need(table: str = "mart_forecast"):
    if not SERVE.has_table(table) or not SERVE.one(f"SELECT count(*) AS n FROM {table}")["n"]:
        raise APIError(404, "NO_FORECAST", "Forecasts are not available yet (run make forecast)")


def _run() -> dict:
    def load():
        if not SERVE.has_table("ml_forecast_runs"):
            return {}
        r = SERVE.one("""SELECT run_id, sim_time, created_at, source, source_label, case_def, first_year, last_full_year, horizon_year,
                                n_draws, runtime_s, backtest, notes FROM ml_forecast_runs ORDER BY created_at DESC LIMIT 1""")
        if r:
            for k in ("backtest", "notes"):
                try:
                    r[k] = json.loads(r[k]) if isinstance(r[k], str) else r[k]
                except ValueError:
                    pass
        return r or {}
    return SERVE.cached(("fc_run",), load)


def _check(v, allowed, name):
    if v not in allowed:
        raise APIError(400, "INVALID_FILTER", f"{name} must be one of {list(allowed)}", {name: v})
    return v


def _code(geo: str, code: str | None) -> str:
    if geo == "NATIONAL":
        return "RW"
    if not code:
        raise APIError(400, "INVALID_FILTER", "code is required for PROVINCE and DISTRICT")
    if (geo == "PROVINCE" and code not in PROVINCES) or (geo == "DISTRICT" and code not in DISTRICTS):
        raise APIError(400, "INVALID_FILTER", f"unknown {geo.lower()} code", {"code": code})
    return code


def _suppress(row: dict) -> dict:
    n = row.get("cases_obs")
    if row.get("kind") == "history" and n is not None and n < 5:
        return {**row, "mean": None, "lo80": None, "hi80": None, "lo95": None, "hi95": None, "cases_obs": None, "cases_label": "<5"}
    return row


def _bt_for(series_id: str) -> dict:
    rows = SERVE.cached(("fc_bt",), lambda: SERVE.rows(
        "SELECT series_id, avg(mape) AS mape, avg(cov80) AS cov80, avg(cov95) AS cov95, avg(crps) AS crps, count(*) AS n "
        "FROM ml_forecast_backtest GROUP BY 1") if SERVE.has_table("ml_forecast_backtest") else [])
    hit = next((x for x in rows if x["series_id"] == series_id), None)
    if hit is None:   # fall back to the national all-ages series for the same case definition
        nat = "NATIONAL|ALL|ALL|" + series_id.split("|")[-1]
        hit = next((x for x in rows if x["series_id"] == nat), None)
        if hit:
            hit = {**hit, "note": "national backtest (no backtest for this series)"}
    return hit or {"mape": None, "cov80": None, "cov95": None, "crps": None, "n": 0}


@router.get("/forecast/series")
def series(geo: str = "NATIONAL", code: str | None = None, sex: str = "ALL", age: str = "ALL", freq: str = "Y",
           metric: str | None = None, case_def: str | None = None, r: Role = Depends(m)):
    _need()
    _check(geo, LEVELS, "geo"), _check(sex, SEX, "sex"), _check(age, AGES, "age"), _check(freq, ("Y", "M"), "freq")
    if freq == "M":
        metric = metric or "gi_visits"
        _check(metric, OPS_METRICS, "metric")
        rows = SERVE.rows("""SELECT period, mean, lo80, hi80, model, run_id FROM mart_forecast WHERE freq = 'M' AND metric = ?
                             ORDER BY period""", [metric])
        return envelope({"series_id": "NATIONAL|ALL|ALL|OPS", "metric": metric, "history": [], "forecast": rows,
                         "model": rows[0]["model"] if rows else None, "backtest": None}, note=SYNTHETIC)
    metric = metric or "cases"
    _check(metric, ("cases", "asr"), "metric")
    cd = case_def or _run().get("case_def") or "REGISTRY"
    code_ = _code(geo, code)
    sid = f"{'NATIONAL' if geo == 'NATIONAL' else code_}|{sex}|{age}|{cd}"
    rows = SERVE.cached(("fc_series", sid, metric), lambda: SERVE.rows(
        """SELECT period, kind, mean, lo80, hi80, lo95, hi95, model, run_id, cases_obs FROM mart_forecast
           WHERE series_id = ? AND metric = ? AND freq = 'Y' ORDER BY period""", [sid, metric]))
    if not rows:
        raise APIError(404, "UNKNOWN_SERIES", f"No forecast for {sid}", {"available_case_def": _run().get("case_def")})
    rows = [_suppress({**x, "year": int(str(x["period"])[:4])}) for x in rows]
    hist = [{k: x.get(k) for k in ("year", "period", "mean", "lo95", "hi95", "cases_label") if k in x} for x in rows if x["kind"] == "history"]
    fc = [{k: x[k] for k in ("year", "period", "mean", "lo80", "hi80", "lo95", "hi95")} for x in rows if x["kind"] == "forecast"]
    model = next((x["model"] for x in rows if x["kind"] == "forecast"), None)
    return envelope({"series_id": sid, "metric": metric, "unit": "cases per year" if metric == "cases" else "ASR per 100,000 (WHO 2000-2025)",
                     "history": hist, "forecast": fc, "model": model, "backtest": _bt_for(sid), "run": _run()}, note=SYNTHETIC)


@router.get("/forecast/drivers")
def drivers(geo: str = "NATIONAL", code: str | None = None, r: Role = Depends(m)):
    _need("mart_forecast_drivers")
    _check(geo, LEVELS, "geo")
    code_ = _code(geo, code)
    rows = SERVE.rows("SELECT * FROM mart_forecast_drivers WHERE geo_level = ? AND geo_code = ? ORDER BY component", [geo, code_])
    if not rows:
        raise APIError(404, "UNKNOWN_SERIES", f"No driver decomposition for {geo} {code_}")
    f = rows[0]
    order = {"population": 0, "ageing": 1, "risk": 2}
    comps = sorted([{"component": x["component"], "cases": x["cases"], "pct": x["pct"]} for x in rows], key=lambda x: order.get(x["component"], 9))
    return envelope({"geo_level": geo, "geo_code": code_, "from_year": f["from_year"], "to_year": f["to_year"], "cases_from": f["cases_from"],
                     "cases_to": f["cases_to"], "total_change": f["total_change"], "components": comps,
                     "method": "Das Gupta three-factor decomposition (population size x age-sex structure x rates); "
                               "components add up exactly to the total change; base year uses model-fitted rates"}, note=SYNTHETIC)


@router.get("/forecast/risk-factors")
def risk_factors(indicator: str | None = None, province: str | None = None, sex: str = "ALL", r: Role = Depends(m)):
    _need("mart_risk_factor_forecast")
    _check(sex, SEX, "sex")
    geo = province or "RW"
    if geo != "RW" and geo not in PROVINCES:
        raise APIError(400, "INVALID_FILTER", "province must be a province code", {"province": province})
    q = "SELECT * FROM mart_risk_factor_forecast WHERE geo_code = ? AND sex = ?"
    p = [geo, sex]
    if indicator:
        q += " AND indicator = ?"
        p.append(indicator)
    rows = SERVE.rows(q + " ORDER BY indicator, period", p)
    out: dict = {}
    for x in rows:
        if x.get("n") is not None and x["n"] < 5 and x["kind"] in ("survey", "nowcast"):
            x = {**x, "value": None, "lo95": None, "hi95": None, "n": None, "label": "<5"}
        d = out.setdefault(x["indicator"], {"indicator": x["indicator"], "geo_code": geo, "sex": sex, "source": x["source"],
                                            "survey": [], "fitted": [], "forecast": [], "nowcast": []})
        key = x["kind"] if x["kind"] in d else "forecast"
        d[key].append({k: x.get(k) for k in ("year", "period", "value", "lo95", "hi95", "n", "label") if k in x})
    inds = sorted({x["indicator"] for x in SERVE.rows("SELECT DISTINCT indicator FROM mart_risk_factor_forecast")})
    return envelope(list(out.values()), indicators=inds, note=SYNTHETIC)


@router.get("/forecast/operational")
def operational(district: str | None = None, r: Role = Depends(m)):
    _need("mart_operational_forecast")
    d = district or "RW"
    if d != "RW" and d not in DISTRICTS:
        raise APIError(400, "INVALID_FILTER", "district must be a district code", {"district": district})
    rows = SERVE.rows("SELECT month, metric, mean, lo80, hi80, as_of FROM mart_operational_forecast WHERE district_code = ? ORDER BY metric, month", [d])
    metrics: dict = {}
    for x in rows:
        metrics.setdefault(x["metric"], []).append({k: x[k] for k in ("month", "mean", "lo80", "hi80")})
    cap = SERVE.cached(("fc_capacity",), lambda: SERVE.rows("""
        SELECT district_code, sum(mean) FILTER (WHERE metric = 'endoscopy_demand') AS demand_12m,
               sum(mean) FILTER (WHERE metric = 'endoscopy_capacity') AS capacity_12m,
               sum(mean) FILTER (WHERE metric = 'high_flags') AS high_flags_12m,
               sum(mean) FILTER (WHERE metric = 'gi_visits') AS gi_visits_12m
        FROM mart_operational_forecast WHERE district_code <> 'RW' GROUP BY 1 ORDER BY 1"""))
    for c in cap:
        c["name"] = DISTRICTS[c["district_code"]][1] if c["district_code"] in DISTRICTS else c["district_code"]
        c["gap_12m"] = (c["demand_12m"] or 0) - (c["capacity_12m"] or 0)
    return envelope({"district": d, "as_of": rows[0]["as_of"] if rows else None, "months": sorted({x["month"] for x in rows}),
                     "metrics": metrics, "capacity_by_district": cap,
                     "method": "Poisson GLM with district effects, trend and seasonality on monthly EMR counts; 80% negative-binomial "
                               "bands; HIGH flags = GI visits x current HIGH share; capacity = 1.25 x p90 of monthly endoscopies"},
                    note=SYNTHETIC)


@router.get("/forecast/backtest")
def backtest(r: Role = Depends(m)):
    if not SERVE.has_table("ml_forecast_backtest"):
        raise APIError(404, "NO_FORECAST", "No backtests yet (run make forecast)")
    rows = SERVE.rows("SELECT * FROM ml_forecast_backtest ORDER BY series_id, origin_year, horizon")
    if not rows:
        return envelope({"summary": {"n": 0}, "by_series": [], "by_horizon": [], "rows": []}, note=SYNTHETIC)
    by_s = SERVE.rows("""SELECT series_id, avg(mape) AS mape, avg(cov80) AS cov80, avg(cov95) AS cov95, avg(crps) AS crps, count(*) AS n
                         FROM ml_forecast_backtest GROUP BY 1 ORDER BY 1""")
    by_h = SERVE.rows("""SELECT horizon, avg(mape) AS mape, avg(cov80) AS cov80, avg(cov95) AS cov95, avg(crps) AS crps, count(*) AS n
                         FROM ml_forecast_backtest GROUP BY 1 ORDER BY 1""")
    s = SERVE.one("""SELECT avg(mape) AS mape, avg(cov80) AS cov80, avg(cov95) AS cov95, avg(crps) AS crps, count(*) AS n,
                            list(DISTINCT origin_year ORDER BY origin_year) AS origins FROM ml_forecast_backtest""")
    return envelope({"summary": s, "by_series": by_s, "by_horizon": by_h, "rows": rows,
                     "method": "Rolling origin: refit on data up to each origin, forecast 5 years; MAPE (%), share of actuals inside "
                               "the 80%/95% bands, CRPS from the predictive draws scaled by the actual"}, note=SYNTHETIC)


@router.get("/forecast/map")
def fc_map(year: int = 2031, metric: str = "asr", r: Role = Depends(m)):
    _need()
    _check(metric, ("asr", "change", "cases"), "metric")
    cd = _run().get("case_def") or "REGISTRY"
    if metric == "change":
        base_year = SERVE.one("SELECT max(from_year) AS y FROM mart_forecast_drivers")["y"] if SERVE.has_table("mart_forecast_drivers") else None
        rows = SERVE.rows("""
            WITH f AS (SELECT geo_code, mean, lo95, hi95 FROM mart_forecast WHERE geo_level = 'DISTRICT' AND metric = 'cases' AND freq = 'Y'
                         AND year(period) = ? AND kind = 'forecast' AND series_id LIKE ?),
                 b AS (SELECT geo_code, cases_from FROM mart_forecast_drivers WHERE geo_level = 'DISTRICT' AND component = 'risk')
            SELECT f.geo_code AS district_code, 100 * (f.mean - b.cases_from) / nullif(b.cases_from, 0) AS value,
                   f.mean AS cases, b.cases_from AS base_cases FROM f JOIN b USING (geo_code) ORDER BY 1""", [year, f"%|{cd}"])
        unit, extra = f"% change in expected cases vs fitted {base_year}", {"base_year": base_year}
    else:
        rows = SERVE.rows("""SELECT geo_code AS district_code, mean AS value, lo95, hi95 FROM mart_forecast WHERE geo_level = 'DISTRICT'
                             AND metric = ? AND freq = 'Y' AND year(period) = ? AND kind = 'forecast' AND series_id LIKE ? ORDER BY 1""",
                          ["asr" if metric == "asr" else "cases", year, f"%|{cd}"])
        unit, extra = ("ASR per 100,000" if metric == "asr" else "expected cases"), {}
    if not rows:
        raise APIError(400, "INVALID_FILTER", f"No district forecast for {year}", {"year": year})
    for x in rows:
        x["name"] = DISTRICTS[x["district_code"]][1]
        x["province_code"] = DISTRICTS[x["district_code"]][0]
    return envelope(rows, year=year, metric=metric, unit=unit, note=SYNTHETIC, **extra)


# ------------------------------------------------------------------------------------------------ scenario
class ScenarioIn(BaseModel):
    hp_coverage_delta: float = Field(0.0, ge=0.0, le=1.0, description="share of H. pylori-infected people newly treated (0-1)")
    smoking_delta: float = Field(0.0, ge=-1.0, le=1.0, description="relative change in smoking prevalence (-0.2 = -20%)")
    salt_delta: float = Field(0.0, ge=-1.0, le=1.0, description="relative change in high-salt diet prevalence")
    endoscopy_access: list[str] = Field(default_factory=list, description="district codes that gain endoscopy access")
    until: int = 2031


def _scenario_base() -> dict:
    def load():
        if not SERVE.has_table("ml_forecast_scenario_base"):
            raise APIError(404, "NO_FORECAST", "Scenario model not fitted yet (run make forecast)")
        b = SERVE.rows("SELECT * FROM ml_forecast_scenario_base ORDER BY district_code, year")
        coef = {x["term"]: (x["value"], x["se"]) for x in SERVE.rows("SELECT term, value, se FROM ml_forecast_coef")}
        cd = _run().get("case_def") or "REGISTRY"
        nat = SERVE.rows("""SELECT year(period) AS year, mean, lo95, hi95 FROM mart_forecast WHERE series_id = ? AND metric = 'cases'
                            AND kind = 'forecast' AND freq = 'Y' ORDER BY period""", [f"NATIONAL|ALL|ALL|{cd}"])
        years = [x["year"] for x in nat]
        dists = sorted({x["district_code"] for x in b})
        di, yi = {d: i for i, d in enumerate(dists)}, {y: j for j, y in enumerate(years)}
        B = np.zeros((len(dists), len(years)))
        first = {}
        for x in b:
            if x["year"] in yi:
                B[di[x["district_code"]], yi[x["year"]]] = x["mean"]
            first.setdefault(x["district_code"], x)
        col = lambda k: [float(first[d][k] or 0.0) for d in dists]  # noqa: E731
        return {"years": years, "districts": dists, "B": B, "hp": col("hp"), "smoking": col("smoking"), "salt": col("salt"),
                "early": col("early_share"), "access": col("has_access"), "sim_year": int(b[0]["sim_year"]) if b else years[0],
                "national": {k: [x[k] for x in nat] for k in ("mean", "lo95", "hi95")},
                "coef": {k: coef.get(k, (0.0, 0.0)) for k in ("hp", "smoking", "salt", "access_early")}}
    return SERVE.cached(("fc_scenario_base",), load)


@router.post("/forecast/scenario")
def scenario(body: ScenarioIn, r: Role = Depends(m)):
    t0 = time.perf_counter()
    from ml.forecast.scenario import evaluate
    base = _scenario_base()
    bad = [d for d in body.endoscopy_access if d not in DISTRICTS]
    if bad:
        raise APIError(400, "INVALID_FILTER", "unknown district codes", {"endoscopy_access": bad})
    if not base["years"] or not (base["years"][0] <= body.until <= base["years"][-1]):
        raise APIError(400, "INVALID_FILTER", f"until must be within {base['years'][:1]}-{base['years'][-1:]}", {"until": body.until})
    out = evaluate(base, body.model_dump(), load_yaml("forecast.yaml"))
    out["coefficients"] = {k: {"value": v[0], "se": v[1]} for k, v in base["coef"].items()}
    out["elapsed_ms"] = round(1000 * (time.perf_counter() - t0), 1)
    return envelope(out, note=SYNTHETIC)


@router.get("/forecast/meta")
def meta(r: Role = Depends(m)):
    run = _run()
    coef = SERVE.rows("SELECT * FROM ml_forecast_coef") if SERVE.has_table("ml_forecast_coef") else []
    return envelope({"run": run, "coefficients": coef}, note=SYNTHETIC)
