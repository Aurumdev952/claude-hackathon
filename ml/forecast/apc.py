"""Age-period-cohort Poisson GLM with a population offset and Nordpred-style damped drift.

log E[cases] = log(population x completeness) + b0 + b_male + ns(age) + drift * period + ns_c(cohort)

- ns(age): natural cubic spline (includes the linear term);
- ns_c(cohort): natural-spline curvature only (the linear cohort trend is not identifiable apart from age + period;
  it is carried by the drift, as in the age-drift-cohort parameterisation). Unobserved future cohorts are held at the
  boundary value;
- a period hinge lets the drift change over the last `recent_years` (Nordpred's "recent trend"), when there is
  enough history; the projection uses the recent slope, attenuated in the projection years (Nordpred: 25%, 50%,
  75% damping), config `drift_damping`;
- period shocks: a random walk on the log rate with the step SD estimated from the yearly residuals (net of Poisson
  noise) widens the bands for model error that the coefficient covariance cannot see;
- quasi-Poisson dispersion (Pearson chi2 / df, floored at 1) inflates the coefficient covariance and the predictive
  negative-binomial noise; intervals come from a parametric bootstrap (draws of beta, then counts).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


def ns_basis(x: np.ndarray, knots: np.ndarray) -> np.ndarray:
    """Natural cubic spline basis without intercept: [x, d_1 - d_{K-1}, ...] (ESL eq. 5.4-5.5)."""
    x = np.asarray(x, float)
    k = np.asarray(knots, float)
    K = len(k)

    def d(j):
        return (np.clip(x - k[j], 0, None) ** 3 - np.clip(x - k[K - 1], 0, None) ** 3) / (k[K - 1] - k[j])

    cols = [x]
    for j in range(K - 2):
        cols.append(d(j) - d(K - 2))
    return np.column_stack(cols)


@dataclass
class APCFit:
    beta: np.ndarray
    cov: np.ndarray
    scale: float
    age_knots: np.ndarray
    coh_knots: np.ndarray
    coh_range: tuple
    ref_year: int
    last_year: int
    age_min: int
    damping: list
    n_obs: int
    deviance: float
    col_mean: np.ndarray | None = None
    col_sd: np.ndarray | None = None
    recent_knot: float | None = None      # period hinge: the drift may change over the last `recent_years` (Nordpred)

    def raw_design(self, age_index, year, male, eff_period=None) -> np.ndarray:
        age = 5 * np.asarray(age_index, float) + 2.5
        year = np.asarray(year, float)
        coh = np.clip(year - age, *self.coh_range)
        per = (year - self.ref_year) if eff_period is None else np.asarray(eff_period, float)
        A = ns_basis(age / 100.0, self.age_knots / 100.0)
        cols = [np.ones_like(age), np.asarray(male, float), A, per / 10.0]
        if self.recent_knot is not None:
            cols.append(np.clip(per + (self.ref_year - self.recent_knot), 0, None) / 10.0)
        if len(self.coh_knots) >= 3:
            cols.append(ns_basis(coh / 100.0, self.coh_knots / 100.0)[:, 1:])  # curvature only
        return np.column_stack(cols)

    def design(self, age_index, year, male, eff_period=None) -> np.ndarray:
        X = self.raw_design(age_index, year, male, eff_period)
        if self.col_mean is None:
            return X
        return (X - self.col_mean) / self.col_sd

    @property
    def drift_index(self) -> int:
        return 2 + len(self.age_knots) - 1

    def effective_period(self, year: np.ndarray) -> np.ndarray:
        """Damped period index for projection years (Nordpred): sum of damping factors over the projection steps."""
        year = np.asarray(year, int)
        out = (np.minimum(year, self.last_year) - self.ref_year).astype(float)
        h = np.clip(year - self.last_year, 0, None)
        hmax = int(h.max()) if len(h) else 0
        cum = np.concatenate([[0.0], np.cumsum([self.damping[min(i, len(self.damping) - 1)] for i in range(hmax)])])
        return out + cum[h]

    def _raw(self, j: int) -> float:
        return float(self.beta[j] / (self.col_sd[j] if self.col_sd is not None else 1.0))

    @property
    def drift_pct(self) -> float:
        """Annual drift in % over the projection base (overall drift + recent change; undamped)."""
        b = self._raw(self.drift_index) + (self._raw(self.drift_index + 1) if self.recent_knot is not None else 0.0)
        return float(100 * (np.exp(b / 10.0) - 1))


def _penalised_poisson(X, y, off, prior_prec, maxit: int = 60):
    """Penalised IRLS (Gaussian priors N(0, 1/prior_prec) on the standardised coefficients) -> beta, cov."""
    beta = np.zeros(X.shape[1])
    beta[0] = np.log(max(y.sum(), 0.5) / np.exp(off).sum())
    P = np.diag(prior_prec)
    for _ in range(maxit):
        eta = np.clip(X @ beta + off, -40, 40)
        mu = np.exp(eta)
        z = eta - off + (y - mu) / mu
        H = X.T @ (X * mu[:, None]) + P
        new = np.linalg.solve(H, X.T @ (mu * z))
        if np.max(np.abs(new - beta)) < 1e-8:
            beta = new
            break
        beta = new
    mu = np.exp(np.clip(X @ beta + off, -40, 40))
    H = X.T @ (X * mu[:, None]) + P
    return beta, np.linalg.inv(H), mu


def fit_apc(cells: pd.DataFrame, c: dict) -> APCFit:
    """cells: year, sex, age_index, cases, population, completeness (aggregated over geography).

    Spline columns are standardised and get weak Gaussian priors (penalised IRLS), so the same code is stable on the
    national registry (tens of thousands of cases) and on the sparse EMR fallback (a few hundred). Model complexity
    also adapts to the number of cases."""
    ic = c["incidence"]
    d = cells[(cells["age_index"] >= ic["age_min_index"]) & (cells["population"] > 0)].copy()
    n_cases = float(d["cases"].sum())
    age_df, coh_df = int(ic["age_df"]), int(ic["cohort_df"])
    if n_cases < 400:
        age_df, coh_df = min(age_df, 3), 0
    elif n_cases < 2000:
        coh_df = min(coh_df, 3)
    age = 5 * d["age_index"].values + 2.5
    coh = d["year"].values - age
    ak = np.unique(np.round(np.quantile(age, np.linspace(0.02, 0.98, age_df)), 3))
    ck = np.unique(np.round(np.quantile(coh, np.linspace(0.05, 0.95, coh_df)), 3)) if coh_df >= 3 else np.array([])
    ref = int(d["year"].max())
    n_years = int(d["year"].nunique())
    recent = int(ic.get("recent_years", 10))
    knot = float(ref - recent) if (n_cases >= 2000 and n_years >= recent + 6) else None
    fit = APCFit(np.zeros(1), np.zeros((1, 1)), 1.0, ak, ck, (float(coh.min()), float(coh.max())), ref, ref,
                 int(ic["age_min_index"]), list(ic["drift_damping"]), len(d), 0.0, recent_knot=knot)
    Xr = fit.raw_design(d["age_index"].values, d["year"].values, (d["sex"] == "M").values)
    m, sd = Xr.mean(axis=0), Xr.std(axis=0)
    m[0], sd[0] = 0.0, 1.0
    sd[sd < 1e-12] = 1.0
    fit.col_mean, fit.col_sd = m, sd
    X = fit.design(d["age_index"].values, d["year"].values, (d["sex"] == "M").values)
    off = np.log(np.maximum(d["population"].values * d["completeness"].values, 1e-12))
    y = d["cases"].values.astype(float)
    # prior precisions: intercept/sex/age-linear/drift nearly flat; spline curvature shrunk (sd 1.5 age, 0.5 cohort)
    prec = np.full(X.shape[1], 1e-6)
    na = len(ak) - 1
    prec[3:2 + na] = 1 / 1.5**2
    j = fit.drift_index
    prec[j] = 1 / 2.0**2 if n_cases >= 2000 else 1 / 0.5**2   # drift (per SD of period): weakly informative on sparse data
    prec[j + 1:] = 1 / 0.5**2
    if knot is not None:
        prec[j + 1] = 1 / 1.0**2    # change of drift over the recent period
    beta, cov, mu = _penalised_poisson(X, y, off, prec)
    dof = max(1, len(y) - X.shape[1])
    scale = float(max(1.0, np.sum((y - mu) ** 2 / np.maximum(mu, 1e-9)) / dof))
    cov = cov * scale
    cov = (cov + cov.T) / 2 + np.eye(len(beta)) * 1e-12
    fit.beta, fit.cov, fit.scale = beta, cov, scale
    fit.deviance = float(2 * np.sum(np.where(y > 0, y * np.log(np.maximum(y, 1e-12) / mu), 0) - (y - mu)))
    return fit


def predict_cells(fit: APCFit, cells: pd.DataFrame, n_draws: int, rng: np.random.Generator, damped: bool = True):
    """cells: year, sex, age_index, population, completeness. Returns (mean mu per cell, mu draws n_draws x cells).
    Cells below the modelled age range get 0."""
    m = cells["age_index"].values >= fit.age_min
    year = cells["year"].values
    eff = fit.effective_period(year) if damped else None
    X = fit.design(cells["age_index"].values, year, (cells["sex"] == "M").values, eff)
    off = np.log(np.maximum(cells["population"].values * cells["completeness"].values, 1e-12))
    mean = np.where(m, np.exp(X @ fit.beta + off), 0.0)
    B = rng.multivariate_normal(fit.beta, fit.cov, size=n_draws, method="cholesky")
    eta = X @ fit.beta
    lin = np.clip(B @ X.T, eta[None, :] - 4.0, eta[None, :] + 4.0)   # guards exp() against extreme tails
    draws = np.where(m[None, :], np.exp(lin + off[None, :]), 0.0)
    return mean, draws


def sample_counts(mu: np.ndarray, scale: float, rng: np.random.Generator) -> np.ndarray:
    """Predictive counts around mean draws mu: Poisson, or negative binomial with variance scale * mu."""
    mu = np.maximum(mu, 1e-12)
    if scale <= 1.0001:
        return rng.poisson(mu).astype(float)
    n = mu / (scale - 1.0)
    p = n / (n + mu)
    return rng.negative_binomial(n, p).astype(float)
