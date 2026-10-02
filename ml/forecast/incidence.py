"""Incidence forecasts: APC Poisson GLM + ETS (log ASR) ensemble for national/province series, empirical-Bayes districts.

Outputs per series and year: mean, 80% and 95% predictive bands from a parametric bootstrap (coefficient draws, then
negative-binomial counts). The ensemble is a 50/50 mixture of APC and ETS draws (config `ets_weight`), so the bands of
the mixture are nested by construction. Province forecasts are reconciled to the national total (top-down, by year).
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from pipeline.metrics.asr import asr as asr_ci, band_weights

from .apc import APCFit, fit_apc, predict_cells, sample_counts
from .data import BANDS, History

SEXES = {"ALL": ("M", "F"), "M": ("M",), "F": ("F",)}
Q = (0.025, 0.10, 0.90, 0.975)


def agg_cells(df: pd.DataFrame, value_cols=("cases",)) -> pd.DataFrame:
    """Aggregate district cells to year x sex x age; completeness is population-weighted."""
    d = df.assign(_cw=df["completeness"] * df["population"]) if "completeness" in df else df.assign(_cw=df["population"])
    g = d.groupby(["year", "sex", "age_index"], as_index=False).agg(
        **{c: (c, "sum") for c in value_cols if c in d}, population=("population", "sum"), _cw=("_cw", "sum"))
    g["completeness"] = np.where(g["population"] > 0, g["_cw"] / g["population"].clip(lower=1e-12), 1.0)
    return g.drop(columns="_cw")


def future_cells(pop: pd.DataFrame, hist: pd.DataFrame, years: list[int], hold_years: int) -> pd.DataFrame:
    p = pop[pop["year"].isin(years)].groupby(["year", "sex", "age_index"], as_index=False)["population"].sum()
    last = hist["year"].max()
    comp = (hist[hist["year"] > last - hold_years].groupby(["sex", "age_index"], as_index=False)["completeness"].mean())
    p = p.merge(comp, on=["sex", "age_index"], how="left")
    p["completeness"] = p["completeness"].fillna(hist["completeness"].mean() if len(hist) else 1.0)
    return p.sort_values(["year", "sex", "age_index"]).reset_index(drop=True)


def ets_log_asr(years: np.ndarray, asr: np.ndarray, H: int, n: int, rng: np.random.Generator) -> np.ndarray | None:
    """Damped-trend ETS on log ASR; returns simulated ASR paths (n x H) or None if it cannot be fitted."""
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    ok = np.isfinite(asr) & (asr > 0)
    if ok.sum() < 8:
        return None
    y = np.log(asr[ok])
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            m = ExponentialSmoothing(y, trend="add", damped_trend=True, initialization_method="estimated").fit()
            sims = m.simulate(H, repetitions=n, error="add", anchor="end", random_state=int(rng.integers(1 << 31)))
    except Exception:
        return None
    sims = np.asarray(sims).reshape(H, n).T
    return np.exp(np.clip(sims, -20, 20))


@dataclass
class SeriesFC:
    years: list[int]
    cases_mean: np.ndarray
    cases_draws: np.ndarray     # n x H (predictive)
    asr_mean: np.ndarray
    asr_draws: np.ndarray
    model: str


class GeoFit:
    """APC fit for one geography plus its future cells and coefficient draws."""

    def __init__(self, hist: pd.DataFrame, pop: pd.DataFrame, years_fc: list[int], c: dict, rng: np.random.Generator,
                 n_draws: int):
        self.c, self.rng, self.n = c, rng, n_draws
        self.hist = agg_cells(hist)
        self.years_fc = list(years_fc)
        self.fit: APCFit = fit_apc(self.hist, c)
        self.fut = future_cells(pop, self.hist, self.years_fc, int(c["incidence"]["completeness_hold_years"]))
        self.mu_mean, self.mu_draws = predict_cells(self.fit, self.fut, n_draws, rng)
        self.fitted_hist, _ = predict_cells(self.fit, self.hist.assign(), 0, rng, damped=False)
        self.factor = np.ones(len(self.years_fc))   # reconciliation factor by forecast year

    # -- helpers
    def _mask(self, frame: pd.DataFrame, sex: str, band: str) -> np.ndarray:
        return frame["sex"].isin(SEXES[sex]).values & frame["age_index"].isin(BANDS[band]).values

    def history(self, sex: str = "ALL", band: str = "ALL") -> pd.DataFrame:
        h = self.hist[self._mask(self.hist, sex, band)]
        rows = []
        for y, g in h.groupby("year"):
            c = np.zeros(18)
            n = np.zeros(18)
            ca = np.zeros(18)
            a = g.groupby("age_index").agg(cases=("cases", "sum"), population=("population", "sum"))
            adj = (g["cases"] / g["completeness"].clip(lower=0.05)).groupby(g["age_index"]).sum()
            c[a.index.values] = a["cases"].values
            n[a.index.values] = a["population"].values
            ca[adj.index.values] = adj.values
            r = asr_ci(c, n, band)
            ra = asr_ci(ca, n, band)
            rows.append({"year": int(y), "cases": float(c.sum()), "asr": r["asr"], "asr_lci": r["asr_lci"], "asr_uci": r["asr_uci"],
                         "asr_adj": ra["asr"]})
        return pd.DataFrame(rows)

    def apc_series(self, sex: str = "ALL", band: str = "ALL") -> SeriesFC:
        idx, w = band_weights(band)
        m = self._mask(self.fut, sex, band)
        fut = self.fut[m]
        mu_d = self.mu_draws[:, m] * self.factor[np.searchsorted(self.years_fc, fut["year"].values)][None, :]
        mu_m = self.mu_mean[m] * self.factor[np.searchsorted(self.years_fc, fut["year"].values)]
        H = len(self.years_fc)
        cases_d = np.zeros((self.n, H))
        cases_m = np.zeros(H)
        asr_d = np.zeros((self.n, H))
        asr_m = np.zeros(H)
        for j, y in enumerate(self.years_fc):
            sel = (fut["year"] == y).values
            ages = fut["age_index"].values[sel]
            pops = fut["population"].values[sel]
            cases_d[:, j] = mu_d[:, sel].sum(axis=1)
            cases_m[j] = mu_m[sel].sum()
            P = np.zeros(18)
            np.add.at(P, ages, pops)
            Cd = np.zeros((self.n, 18))
            for k, a in enumerate(ages):
                Cd[:, a] += mu_d[:, sel][:, k]
            Cm = np.zeros(18)
            np.add.at(Cm, ages, mu_m[sel])
            rate_d = np.divide(Cd[:, idx], P[idx], out=np.zeros((self.n, len(idx))), where=P[idx] > 0)
            rate_m = np.divide(Cm[idx], P[idx], out=np.zeros(len(idx)), where=P[idx] > 0)
            asr_d[:, j] = (rate_d * w).sum(axis=1) * 1e5
            asr_m[j] = (rate_m * w).sum() * 1e5
        counts = sample_counts(cases_d, self.fit.scale, self.rng)
        noise = np.divide(counts, cases_d, out=np.ones_like(counts), where=cases_d > 0)
        return SeriesFC(self.years_fc, cases_m, counts, asr_m, asr_d * noise, "apc")

    def series(self, sex: str = "ALL", band: str = "ALL", ets: bool = True) -> SeriesFC:
        a = self.apc_series(sex, band)
        w = float(self.c["incidence"]["ets_weight"])
        if not ets or band != "ALL" or w <= 0:
            return a
        h = self.history(sex, band)
        if len(h) < int(self.c["incidence"]["ets_min_years"]):
            return a
        H = len(self.years_fc)
        sims = ets_log_asr(h["year"].values, h["asr_adj"].values.astype(float), H, self.n, self.rng)
        if sims is None:
            return a
        last = h.tail(int(self.c["incidence"]["completeness_hold_years"]))
        hold = float(np.nanmean(last["asr"] / last["asr_adj"].replace(0, np.nan))) if len(last) else 1.0
        hold = hold if np.isfinite(hold) and hold > 0 else 1.0
        e_asr = sims * hold * self.factor[None, :]
        ratio = np.divide(a.cases_mean, a.asr_mean, out=np.zeros(H), where=a.asr_mean > 0)
        e_mu = e_asr * ratio[None, :]
        e_cases = e_mu   # ETS residuals were fitted on observed rates, so its paths are already predictive
        k = int(round(w * self.n))
        pick_a = self.rng.permutation(self.n)[: self.n - k]
        pick_e = self.rng.permutation(self.n)[:k]
        cases_d = np.vstack([a.cases_draws[pick_a], e_cases[pick_e]])
        asr_d = np.vstack([a.asr_draws[pick_a], e_asr[pick_e]])
        return SeriesFC(self.years_fc, (1 - w) * a.cases_mean + w * e_mu.mean(axis=0), cases_d,
                        (1 - w) * a.asr_mean + w * (sims * hold * self.factor[None, :]).mean(axis=0), asr_d, "ensemble(apc+ets)")

    def rates_draws(self):
        """Mean and draws of cell rates (per person) for the future cells, reconciled."""
        f = self.factor[np.searchsorted(self.years_fc, self.fut["year"].values)]
        pop = np.maximum(self.fut["population"].values, 1e-12)
        return self.mu_mean * f / pop, self.mu_draws * f[None, :] / pop[None, :]


def quantiles(draws: np.ndarray) -> np.ndarray:
    """(4, H): lo95, lo80, hi80, hi95."""
    return np.quantile(draws, Q, axis=0)


def eb_district_factors(h: History, years_back: int = 10) -> pd.DataFrame:
    """Empirical-Bayes (gamma-Poisson, Marshall 1991) district SIRs relative to their province."""
    cells = h.cells[h.cells["year"] > h.last_full - years_back]
    prov = cells.groupby(["province_code", "year", "sex", "age_index"], as_index=False)[["cases", "population"]].sum()
    prov["rate"] = np.where(prov["population"] > 0, prov["cases"] / prov["population"].clip(lower=1e-12), 0.0)
    d = cells.merge(prov[["province_code", "year", "sex", "age_index", "rate"]], on=["province_code", "year", "sex", "age_index"])
    d["E"] = d["rate"] * d["population"]
    g = d.groupby(["province_code", "district_code"], as_index=False).agg(O=("cases", "sum"), E=("E", "sum"))
    out = []
    for p, gp in g.groupby("province_code"):
        obs, E = gp["O"].values.astype(float), np.maximum(gp["E"].values.astype(float), 1e-9)
        m = obs.sum() / E.sum() if E.sum() > 0 else 1.0
        sir = obs / E
        s2 = float(np.sum(E * (sir - m) ** 2) / E.sum())
        tau2 = max(s2 - m / E.mean(), 1e-4)
        a, b = m * m / tau2, m / tau2
        post = (obs + a) / (E + b)
        for i, dc in enumerate(gp["district_code"]):
            out.append({"district_code": dc, "province_code": p, "O": obs[i], "E": E[i], "sir_raw": sir[i], "sir_eb": post[i],
                        "shape": obs[i] + a, "rate": E[i] + b})
    return pd.DataFrame(out)
