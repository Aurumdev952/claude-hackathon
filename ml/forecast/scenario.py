"""Covariate model and closed-form scenarios ("what if H. pylori test-and-treat coverage rises by X%?").

Fit (in `make forecast`): Poisson GLM on district-years,
    cases_dy ~ Poisson(E_dy * exp(b0 + b_hp * HP_d,y-lag + b_smk * SMK_d,y-lag + b_salt * SALT_d,y-lag + b_acc * ACCESS_dy))
with E_dy the expected cases from the national age-sex rates of that year (indirect standardisation), prevalences from
the province survey trends lagged `lag_years`, and ACCESS = endoscopy-capable facility in the district. The fitted
coefficients are blended with priors (the generator's relative risks turned into log-linear slopes at the mean
prevalence) by precision weighting, since survey prevalences vary only between provinces.
Stage: a binomial GLM of stage I/II share on endoscopy access (blended with a prior).

Evaluate (API, closed form, numpy only): the district baseline forecasts are multiplied by
    exp(ramp(t) * (b_hp * dHP + b_smk * dSMK + b_salt * dSALT))
where dHP = -HP * coverage * efficacy * excess_removed and dSMK/dSALT are relative changes of prevalence; ramp builds
the effect over `ramp_years`. Endoscopy access changes the stage mix only. All effects are ASSOCIATIONAL and SYNTHETIC.
"""
from __future__ import annotations

import math

import numpy as np

TERMS = ("hp", "smoking", "salt")
INDICATOR = {"hp": "hp_seroprev", "smoking": "smoking_current", "salt": "high_salt"}


def prior_slope(rr: float, p_mean: float) -> float:
    """Log-linear slope per unit prevalence equivalent to a relative risk `rr` at mean prevalence p."""
    return (rr - 1.0) / (1.0 + p_mean * (rr - 1.0))


def blend(fit: float | None, fit_se: float | None, prior: float, prior_sd: float) -> tuple[float, float, str]:
    if fit is None or fit_se is None or not math.isfinite(fit) or not math.isfinite(fit_se) or fit_se <= 0:
        return prior, prior_sd, "prior"
    wf, wp = 1 / fit_se**2, 1 / prior_sd**2
    v = (fit * wf + prior * wp) / (wf + wp)
    return float(v), float(math.sqrt(1 / (wf + wp))), "blend"


def fit_covariates(dy, c: dict) -> list[dict]:
    """dy: DataFrame district_code, year, cases, E, hp, smoking, salt, access. Returns coefficient rows."""
    import statsmodels.api as sm
    sc = c["scenario"]
    d = dy[(dy["E"] > 0)].dropna(subset=list(TERMS))
    fit, se = {}, {}
    if len(d) >= 20 and d["cases"].sum() >= 20:
        cols = list(TERMS) + (["access"] if d["access"].nunique() > 1 else [])
        X = sm.add_constant(d[cols].astype(float).values, has_constant="add")
        try:
            r = sm.GLM(d["cases"].values.astype(float), X, family=sm.families.Poisson(), offset=np.log(d["E"].values)).fit()
            mu = r.fittedvalues
            scale = max(1.0, float(np.sum((d["cases"].values - mu) ** 2 / np.maximum(mu, 1e-9)) / max(1, len(d) - X.shape[1])))
            b, s = r.params, np.sqrt(np.diag(r.cov_params()) * scale)
            for i, t in enumerate(cols):
                fit[t], se[t] = float(b[i + 1]), float(s[i + 1])
        except Exception:
            pass
    rows = []
    for t in TERMS:
        pr = sc["priors"][t]
        pm = float(d[t].mean()) if len(d) else 0.3
        p0 = prior_slope(float(pr["rr"]), pm)
        v, s, how = blend(fit.get(t), se.get(t), p0, float(pr["sd"]))
        rows.append({"term": t, "fit": fit.get(t), "fit_se": se.get(t), "prior": p0, "prior_sd": float(pr["sd"]), "value": v, "se": s,
                     "method": how, "mean_prevalence": pm, "scale": "log-rate per unit prevalence"})
    rows.append({"term": "access_incidence", "fit": fit.get("access"), "fit_se": se.get("access"), "prior": None, "prior_sd": None,
                 "value": fit.get("access", 0.0), "se": se.get("access"), "method": "fit (nuisance, not used in scenarios)",
                 "mean_prevalence": None, "scale": "log-rate"})
    return rows


def fit_stage_access(stage, access_of, c: dict) -> dict:
    """stage: DataFrame district_code, year, cases, early_share; access_of(district, year) -> 0/1."""
    import statsmodels.api as sm
    pr = c["scenario"]["access_early_logodds"]
    fit = fit_se = None
    s = stage.dropna(subset=["early_share"]) if len(stage) else stage
    if len(s) >= 10:
        s = s[s["cases"] > 0]
        acc = np.array([access_of(d, y) for d, y in zip(s["district_code"], s["year"])], float)
        if 0 < acc.mean() < 1:
            k = np.clip(s["early_share"].values, 0, 1) * s["cases"].values
            endog = np.column_stack([k, s["cases"].values - k])
            try:
                r = sm.GLM(endog, sm.add_constant(acc, has_constant="add"), family=sm.families.Binomial()).fit()
                fit, fit_se = float(r.params[1]), float(r.bse[1])
            except Exception:
                pass
    v, se, how = blend(fit, fit_se, float(pr["prior"]), float(pr["sd"]))
    return {"term": "access_early", "fit": fit, "fit_se": fit_se, "prior": float(pr["prior"]), "prior_sd": float(pr["sd"]), "value": v,
            "se": se, "method": how, "mean_prevalence": None, "scale": "log-odds of stage I/II"}


def _expit(x):
    return 1 / (1 + np.exp(-x))


def _logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def evaluate(base: dict, params: dict, c: dict) -> dict:
    """Closed-form scenario.

    base: {years: [Y], districts: [D], B: D x Y district baseline means, hp/smoking/salt/early/access: [D],
           national: {mean, lo95, hi95: [Y]}, coef: {hp, smoking, salt, access_early: (value, se)}, sim_year}
    params: hp_coverage_delta (0..1), smoking_delta (-1..1, relative), salt_delta (-1..1, relative),
            endoscopy_access: [district_code], until (year)
    """
    sc = c["scenario"]
    years = np.asarray(base["years"], int)
    until = int(params.get("until") or years.max())
    keep = years <= until
    years = years[keep]
    B = np.asarray(base["B"], float)[:, keep]
    nat = {k: np.asarray(base["national"][k], float)[keep] for k in ("mean", "lo95", "hi95")}
    hp_cov = float(np.clip(params.get("hp_coverage_delta") or 0.0, 0.0, 1.0))
    smk = float(np.clip(params.get("smoking_delta") or 0.0, -1.0, 1.0))
    salt = float(np.clip(params.get("salt_delta") or 0.0, -1.0, 1.0))
    ramp = np.clip((years - int(base["sim_year"])) / float(sc["ramp_years"]), 0.0, 1.0)
    d_hp = -np.asarray(base["hp"], float) * hp_cov * float(sc["hp_eradication_efficacy"]) * float(sc["hp_excess_removed"])
    d_smk = np.asarray(base["smoking"], float) * smk
    d_salt = np.asarray(base["salt"], float) * salt
    co = base["coef"]

    def run(sign: float):
        b = {t: co[t][0] + sign * 1.96 * (co[t][1] or 0.0) for t in TERMS}
        lin = b["hp"] * d_hp + b["smoking"] * d_smk + b["salt"] * d_salt
        mult = np.exp(np.outer(lin, ramp))
        tot = B.sum(axis=0)
        ratio = np.divide((B * mult).sum(axis=0), tot, out=np.ones_like(tot), where=tot > 0)
        return ratio

    ratio = run(0.0)
    scen = {k: nat[k] * ratio for k in nat}
    averted = float(np.sum(nat["mean"] - scen["mean"]))
    r_lo, r_hi = run(+1.0), run(-1.0)  # stronger/weaker slopes
    alt = sorted([float(np.sum(nat["mean"] * (1 - r_lo))), float(np.sum(nat["mean"] * (1 - r_hi)))])
    # stage shift from new endoscopy access (districts without access only)
    dist = list(base["districts"])
    early = np.asarray(base["early"], float)
    access = np.asarray(base["access"], float)
    share = B[:, -1] / max(B[:, -1].sum(), 1e-9)
    targets = np.array([d in set(params.get("endoscopy_access") or []) for d in dist])
    gain = targets & (access < 0.5)
    early_s = np.where(gain, _expit(_logit(early) + co["access_early"][0]), early)
    out = {
        "baseline": [{"year": int(y), "mean": float(m), "lo95": float(lo), "hi95": float(hi)}
                     for y, m, lo, hi in zip(years, nat["mean"], nat["lo95"], nat["hi95"])],
        "scenario": [{"year": int(y), "mean": float(m), "lo95": float(lo), "hi95": float(hi)}
                     for y, m, lo, hi in zip(years, scen["mean"], scen["lo95"], scen["hi95"])],
        "cases_averted": averted,
        "cases_averted_range": alt,
        "stage_shift": {"early_pct_baseline": float(100 * (share * early).sum()), "early_pct_scenario": float(100 * (share * early_s).sum()),
                        "districts_gaining_access": [d for d, g in zip(dist, gain) if g]},
        "assumptions": [
            "Synthetic data; associational effects from a covariate model, not causal estimates.",
            f"H. pylori test-and-treat: {100 * hp_cov:.0f}% of infected people treated, {100 * sc['hp_eradication_efficacy']:.0f}% eradicated, "
            f"{100 * sc['hp_excess_removed']:.0f}% of the excess risk removed after eradication.",
            f"Smoking prevalence changed by {100 * smk:+.0f}% and high-salt diet by {100 * salt:+.0f}% (relative).",
            f"Effects build up linearly over {sc['ramp_years']} years from {int(base['sim_year'])} (exposure-to-incidence lag).",
            "Endoscopy access changes the stage at diagnosis only (earlier detection), not incidence.",
            "Intervals scale the baseline 95% band by the scenario ratio; cases_averted_range varies the slopes by +/-1.96 SE.",
        ],
    }
    return out
