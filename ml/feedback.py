"""Verified-outcome feedback labels for the learning loop (docs/contracts/v3-loop.md §5: ml_feedback_labels).

Sources (all synthetic):
- `care_outcome`: care plans (L2 `care_plans` + `care_tasks`), landmark = approval date. Only screening pathways
  (ENDOSCOPY_REFERRAL, and ANAEMIA_WORKUP once it escalates to an endoscopy) with a completed ENDOSCOPY give a cancer
  label: 1 when a diagnosis (or a CANCER_FOUND result) falls between approval and endoscopy + 60 days, 0 once 60 days
  have passed after the endoscopy without one; still pending otherwise. Patients diagnosed before the approval are
  excluded. H. pylori plans give `hp` labels (first H. pylori test result), never cancer labels; oncology,
  survivorship and palliative plans give no labels;
- `endoscopy_after_flag` / `hp_after_flag`: a HIGH flag (ml_risk_history) followed by an endoscopy or an H. pylori test
  within the follow-up window. Label = gastric cancer diagnosed by the endoscopy (verified negative once 60 days have
  passed without a diagnosis) or the HP result. Works before any care plan exists;
- `flag_backfill`: the champion's "virtual flags" on past quarterly landmarks (built by ml/retrain.py, stored in
  ml_feedback_backfill), so the loop has verified outcomes on the dev data from day one.

Selective labels: flagged patients get scoped more, so labels exist mostly where the model already said HIGH. Each
row carries the propensity of being verified, P(verified | features), from a logistic model fitted on the population
the source verifies from (care plans: logit risk at approval + band at approval + facility tier, "verified" = the
label exists; flags: logit risk, "verified" = an endoscopy within the follow-up). The risk score itself is never used
as a propensity. `ipw_weight` is the stabilised inverse-propensity weight P(verified) / P(verified | x), clipped to
`IPW_CLIP` (mean about 1 among verified rows, so it mixes with unweighted landmark rows), used by ml/retrain.py. Also
adds the loop features used by the challenger (`add_loop_features`).
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3

import numpy as np
import pandas as pd

from shared.config import ANALYTICS_DIR

COLS = ["patient_id", "landmark_date", "label", "label_kind", "source", "verified", "propensity", "risk_at_landmark",
        "outcome_date", "model_id", "plan_id", "ipw_weight"]
DDL = """CREATE TABLE IF NOT EXISTS ml_feedback_labels (patient_id BIGINT, landmark_date DATE, label INTEGER, label_kind VARCHAR,
         source VARCHAR, verified BOOLEAN, propensity DOUBLE, risk_at_landmark DOUBLE, outcome_date DATE, model_id VARCHAR,
         plan_id VARCHAR, ipw_weight DOUBLE)"""
SCREENING = ("ENDOSCOPY_REFERRAL", "ANAEMIA_WORKUP")
HP_PATHWAYS = ("HP_TEST_AND_TREAT",)
NEG_CONFIRM_DAYS = 60     # a negative endoscopy label is final this many days after the endoscopy
CARE_FOLLOWUP_DAYS = 180  # a screening plan with no endoscopy this long after approval counts as "not verified"
IPW_CLIP = (0.1, 10.0)    # clip of the stabilised weight P(verified) / P(verified | x)
LOOP_FEATURES = ["prior_negative_endoscopy_months", "care_plan_open", "missed_followups_12m"]   # + hp_eradicated (features.py)


def _has(con, t: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [t]).fetchone()[0] > 0


def care_table(con, name: str) -> pd.DataFrame | None:
    """A care-engine table from the DuckDB snapshot (care_<name> or <name>), else straight from care.sqlite."""
    for t in (name if name.startswith("care_") else f"care_{name}", name):
        if _has(con, t):
            try:
                return con.execute(f"SELECT * FROM {t}").df()
            except Exception:
                pass
    p = ANALYTICS_DIR / "care.sqlite"
    if p.exists():
        try:
            with sqlite3.connect(f"file:{p}?mode=ro", uri=True) as s:
                return pd.read_sql_query(f"SELECT * FROM {name}", s)
        except Exception:
            return None
    return None


def _date(v):
    if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NaT:
        return None
    try:
        t = pd.Timestamp(v)
    except (ValueError, TypeError):
        return None
    return None if pd.isna(t) else t


def _facility_tier(con) -> dict[int, str]:
    for sql in ("SELECT location_id, derived_tier FROM ml_facility_tier",
                "SELECT location_id, hp_testing_tier FROM core_dim_location"):
        try:
            return {int(a): str(b) for a, b in con.execute(sql).fetchall() if a is not None}
        except Exception:
            continue
    return {}


def _dx_dates(con) -> dict[int, pd.Timestamp]:
    if not _has(con, "core_gc_case"):
        return {}
    return {int(a): pd.Timestamp(b) for a, b in con.execute(
        "SELECT patient_id, dx_date FROM core_gc_case WHERE dx_date IS NOT NULL").fetchall()}


def stabilised_weight(p, marginal: float | None) -> np.ndarray:
    """P(verified) / P(verified | x), clipped to IPW_CLIP; NaN where either is unknown."""
    p = np.asarray(pd.to_numeric(pd.Series(np.atleast_1d(p)), errors="coerce"), float)
    if marginal is None or not np.isfinite(marginal) or marginal <= 0:
        return np.full(len(p), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        w = marginal / np.clip(p, 1e-3, 1.0)
    return np.where(np.isfinite(p), np.clip(w, *IPW_CLIP), np.nan)


def _care_outcomes(con, sim_time: dt.datetime | None = None) -> pd.DataFrame:
    """Labels from care plans (see the module docstring), with P(verified | risk, band, facility tier)."""
    plans, tasks = care_table(con, "care_plans"), care_table(con, "care_tasks")
    if plans is None or plans.empty or tasks is None or tasks.empty or "approved_at" not in plans:
        return pd.DataFrame(columns=COLS)
    T = pd.Timestamp(sim_time) if sim_time is not None else pd.Timestamp.max
    dx = _dx_dates(con)
    tiers = _facility_tier(con)
    tasks = tasks.copy()
    tasks["completed_at"] = pd.to_datetime(tasks["completed_at"], errors="coerce")
    by_plan = {k: g.sort_values("completed_at") for k, g in tasks[tasks["status"] == "COMPLETED"].groupby("plan_id")}
    scr, out = [], []
    for p in plans.itertuples(index=False):
        L = _date(p.approved_at)
        if L is None:
            continue
        pid = int(p.patient_id)
        done = by_plan.get(p.id, tasks.head(0))
        if p.pathway in HP_PATHWAYS:
            hp = done[(done["type"] == "HP_TEST") & done["result"].isin(["POSITIVE", "NEGATIVE"])]
            if len(hp):
                h = hp.iloc[0]
                out.append({"patient_id": pid, "landmark_date": L.date(), "label": int(h["result"] == "POSITIVE"),
                            "label_kind": "hp", "source": "care_outcome", "verified": True, "propensity": None,
                            "risk_at_landmark": _num(p.risk_at_approval), "outcome_date": h["completed_at"].date(),
                            "model_id": None, "plan_id": p.id, "ipw_weight": None})
            continue
        if p.pathway not in SCREENING:
            continue                      # oncology, survivorship, palliative: no screening label
        d = dx.get(pid)
        if d is not None and d.normalize() < L.normalize():
            continue                      # diagnosed before the landmark: not a screening outcome
        endo = done[done["type"] == "ENDOSCOPY"]
        label = od = None
        if len(endo):
            E = endo["completed_at"].iloc[0]
            end = E + pd.Timedelta(days=NEG_CONFIRM_DAYS)
            found = done[(done["result"] == "CANCER_FOUND") & (done["completed_at"] <= end)]
            if d is not None and L.normalize() <= d.normalize() <= end.normalize():
                label, od = 1, d
            elif len(found):
                label, od = 1, found["completed_at"].iloc[0]
            elif end <= T:
                label, od = 0, E
        decided = label is not None or (not len(endo) and L + pd.Timedelta(days=CARE_FOLLOWUP_DAYS) <= T)
        scr.append({"patient_id": pid, "L": L, "label": label, "outcome": od, "plan_id": p.id, "decided": decided,
                    "verified": label is not None, "risk": _num(p.risk_at_approval),
                    "band": str(getattr(p, "band_at_approval", None) or "UNKNOWN"),
                    "tier": tiers.get(int(_num(p.facility_id)), "unknown") if _num(p.facility_id) is not None else "unknown"})
    if scr:
        sdf = pd.DataFrame(scr)
        pop = sdf[sdf["decided"]]
        model = verification_model(pop, ["band", "tier"])
        marginal = float(pop["verified"].mean()) if len(pop) else None
        lab = sdf[sdf["label"].notna()].copy()
        if len(lab):
            lab["propensity"] = model(lab)
            lab["ipw_weight"] = stabilised_weight(lab["propensity"].values, marginal)
            for r in lab.itertuples(index=False):
                out.append({"patient_id": r.patient_id, "landmark_date": r.L.date(), "label": int(r.label),
                            "label_kind": "cancer", "source": "care_outcome", "verified": True,
                            "propensity": float(r.propensity), "risk_at_landmark": r.risk,
                            "outcome_date": pd.Timestamp(r.outcome).date(), "model_id": None, "plan_id": r.plan_id,
                            "ipw_weight": None if pd.isna(r.ipw_weight) else float(r.ipw_weight)})
    return pd.DataFrame(out, columns=COLS)


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


def verification_model(df: pd.DataFrame, cat_cols: list[str], x_col: str = "risk", y_col: str = "verified"):
    """Logistic P(verified | logit risk + categorical covariates). Returns a callable on a DataFrame with the same
    columns. Missing risk uses the population median; thin data (< 30 rows or < 5 per class) -> the empirical rate."""
    d = df.copy()
    y = d[y_col].astype(int).values if len(d) else np.array([], int)
    rate = float(np.clip(y.mean() if len(y) else 0.5, 0.02, 0.98))
    if len(d) < 30 or y.sum() < 5 or y.sum() > len(y) - 5:
        return lambda q: np.full(len(q), rate)
    from sklearn.linear_model import LogisticRegression
    med = float(pd.to_numeric(d[x_col], errors="coerce").median()) if pd.to_numeric(d[x_col], errors="coerce").notna().any() else 0.05
    levels = {c: sorted(d[c].astype(str).unique()) for c in cat_cols}

    def design(q: pd.DataFrame) -> np.ndarray:
        r = np.clip(pd.to_numeric(q[x_col], errors="coerce").fillna(med).values.astype(float), 1e-4, 1 - 1e-4)
        cols = [np.log(r / (1 - r))]
        for c, lv in levels.items():
            v = q[c].astype(str).values
            cols += [(v == x).astype(float) for x in lv[1:]]
        return np.column_stack(cols)

    m = LogisticRegression(C=1.0, max_iter=500).fit(design(d), y)
    return lambda q: m.predict_proba(design(q))[:, 1]


def propensity_model(df: pd.DataFrame, x_col: str = "risk", y_col: str = "scoped"):
    """Logistic P(verified | logit risk). Returns a callable; falls back to the empirical rate when data are thin."""
    d = df.dropna(subset=[x_col])
    y = d[y_col].astype(int).values
    rate = float(np.clip(y.mean() if len(y) else 0.5, 0.02, 0.98))
    if len(d) < 30 or y.sum() < 5 or y.sum() > len(y) - 5:
        return lambda r: np.full(len(np.atleast_1d(r)), rate)
    from sklearn.linear_model import LogisticRegression
    x = np.log(np.clip(d[x_col].values, 1e-4, 1 - 1e-4) / (1 - np.clip(d[x_col].values, 1e-4, 1 - 1e-4)))
    m = LogisticRegression(C=1.0).fit(x[:, None], y)

    def f(r):
        r = np.clip(np.atleast_1d(np.asarray(r, float)), 1e-4, 1 - 1e-4)
        return m.predict_proba(np.log(r / (1 - r))[:, None])[:, 1]
    return f


def _flag_followups(con, sim_time: dt.datetime, followup_days: int = 180) -> pd.DataFrame:
    if not (_has(con, "ml_risk_history") and _has(con, "core_fact_encounter")):
        return pd.DataFrame(columns=COLS)
    T = pd.Timestamp(sim_time)
    snaps = con.execute(f"""
        WITH s AS (SELECT patient_id, CAST(as_of AS DATE) AS L, ensemble_prob AS risk, risk_band FROM ml_risk_history),
        e AS (SELECT patient_id, CAST(encounter_datetime AS DATE) AS t FROM core_fact_encounter WHERE encounter_type = 5),
        hp AS (SELECT patient_id, CAST(datetime AS DATE) AS t, (value_coded = 7001)::INT AS pos FROM core_fact_lab
               WHERE concept_id IN (3120, 3121, 3122))
        SELECT s.*, (SELECT min(e.t) FROM e WHERE e.patient_id = s.patient_id AND e.t > s.L AND e.t <= s.L + INTERVAL {followup_days} DAY) AS endo_t,
               (SELECT arg_min(hp.pos, hp.t) FROM hp WHERE hp.patient_id = s.patient_id AND hp.t > s.L AND hp.t <= s.L + INTERVAL {followup_days} DAY) AS hp_pos,
               (SELECT min(hp.t) FROM hp WHERE hp.patient_id = s.patient_id AND hp.t > s.L AND hp.t <= s.L + INTERVAL {followup_days} DAY) AS hp_t,
               c.dx_date
        FROM s LEFT JOIN core_gc_case c USING (patient_id)""").df()
    if snaps.empty:
        return pd.DataFrame(columns=COLS)
    snaps["L"] = pd.to_datetime(snaps["L"])
    # propensity from snapshots whose follow-up window is complete
    done = snaps[snaps["L"] + pd.Timedelta(days=followup_days) <= T].assign(scoped=lambda d: d["endo_t"].notna())
    prop = propensity_model(done)
    marginal = float(done["scoped"].mean()) if len(done) else None
    hi = snaps[snaps["risk_band"] == "HIGH"].sort_values("L").drop_duplicates("patient_id")   # first HIGH flag per patient
    out = []
    for r in hi.itertuples():
        if pd.notna(r.endo_t):
            et = pd.Timestamp(r.endo_t)
            dx = pd.Timestamp(r.dx_date) if pd.notna(r.dx_date) else None
            if dx is not None and r.L < dx <= et + pd.Timedelta(days=60):
                lab, od = 1, dx
            elif et + pd.Timedelta(days=60) <= T:
                lab, od = 0, et
            else:
                lab = None
            if lab is not None:
                pr = float(prop([r.risk])[0])
                out.append({"patient_id": int(r.patient_id), "landmark_date": r.L.date(), "label": lab, "label_kind": "cancer",
                            "source": "endoscopy_after_flag", "verified": True, "propensity": pr,
                            "risk_at_landmark": float(r.risk), "outcome_date": od.date(), "model_id": None, "plan_id": None,
                            "ipw_weight": float(stabilised_weight([pr], marginal)[0])})
        if pd.notna(r.hp_t):
            out.append({"patient_id": int(r.patient_id), "landmark_date": r.L.date(), "label": int(r.hp_pos), "label_kind": "hp",
                        "source": "hp_after_flag", "verified": True, "propensity": None, "risk_at_landmark": float(r.risk),
                        "outcome_date": pd.Timestamp(r.hp_t).date(), "model_id": None, "plan_id": None, "ipw_weight": None})
    return pd.DataFrame(out, columns=COLS)


def build_feedback_labels(con, sim_time: dt.datetime, log=print) -> pd.DataFrame:
    parts = [_care_outcomes(con, sim_time), _flag_followups(con, sim_time)]
    if _has(con, "ml_feedback_backfill"):
        have = {r[0] for r in con.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'ml_feedback_backfill'").fetchall()}
        sel = ", ".join(c if c in have else f"NULL AS {c}" for c in COLS)  # older backfill tables lack ipw_weight
        parts.append(con.execute(f"SELECT {sel} FROM ml_feedback_backfill").df())
    parts = [p for p in parts if p is not None and len(p)]
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=COLS)
    df = df.drop_duplicates(["patient_id", "landmark_date", "source", "label_kind"])
    con.execute("DROP TABLE IF EXISTS ml_feedback_labels")
    con.execute(DDL)
    if len(df):
        df = df[COLS].copy()
        df["landmark_date"] = pd.to_datetime(df["landmark_date"]).dt.date
        df["outcome_date"] = pd.to_datetime(df["outcome_date"]).dt.date
        con.register("_fb", df)
        con.execute("INSERT INTO ml_feedback_labels BY NAME SELECT * FROM _fb")
        con.unregister("_fb")
    by = df.groupby("source").size().to_dict() if len(df) else {}
    log(f"      ml_feedback_labels: {len(df):,} rows {json.dumps(by)}")
    return df


def add_loop_features(con, feats: pd.DataFrame, X: pd.DataFrame) -> pd.DataFrame:
    """Add the learning-loop features for (patient_id, L) rows of `feats` to the design matrix X (same row order).

    - prior_negative_endoscopy_months: months since the last endoscopy done >= 60 days before L (patients in the
      landmark set have no diagnosis by L, so it was negative); NaN when never scoped;
    - care_plan_open: a care plan approved on/before L and not closed by L (0 before care plans exist);
    - missed_followups_12m: care tasks due in (L - 365 d, L] not completed by their due date (0 without care data).
    `hp_eradicated` already exists in ml/features.py."""
    lm = feats[["patient_id", "L"]].copy()
    lm["L"] = pd.to_datetime(lm["L"])
    lm["_row"] = np.arange(len(lm))
    con.register("_loop_lm", lm)
    try:
        endo = con.execute("""
            SELECT l._row, date_diff('day', max(CAST(e.encounter_datetime AS DATE)), CAST(l.L AS DATE)) / 30.44 AS m
            FROM _loop_lm l JOIN core_fact_encounter e ON e.patient_id = l.patient_id AND e.encounter_type = 5
             AND e.encounter_datetime <= l.L - INTERVAL 60 DAY GROUP BY l._row, l.L""").df()
    finally:
        con.unregister("_loop_lm")
    out = X.copy()
    v = np.full(len(lm), np.nan)
    v[endo["_row"].values.astype(int)] = endo["m"].values
    out["prior_negative_endoscopy_months"] = v
    out["care_plan_open"] = 0.0
    out["missed_followups_12m"] = 0.0
    plans = care_table(con, "care_plans")
    if plans is not None and len(plans) and "approved_at" in plans:
        p = plans[["patient_id", "approved_at", "closed_sim"]].copy()
        p["approved_at"] = pd.to_datetime(p["approved_at"], errors="coerce")
        p["closed_sim"] = pd.to_datetime(p["closed_sim"], errors="coerce")
        m = lm.merge(p, on="patient_id")
        m = m[(m["approved_at"] <= m["L"]) & (m["closed_sim"].isna() | (m["closed_sim"] > m["L"]))]
        out.loc[out.index[m["_row"].unique()], "care_plan_open"] = 1.0
    tasks = care_table(con, "care_tasks")
    if tasks is not None and len(tasks) and "due_at" in tasks:
        t = tasks[["patient_id", "due_at", "completed_at"]].copy()
        t["due_at"] = pd.to_datetime(t["due_at"], errors="coerce")
        t["completed_at"] = pd.to_datetime(t["completed_at"], errors="coerce")
        m = lm.merge(t, on="patient_id")
        m = m[(m["due_at"] <= m["L"]) & (m["due_at"] > m["L"] - pd.Timedelta(days=365))
              & (m["completed_at"].isna() | (m["completed_at"] > m["due_at"]))]
        cnt = m.groupby("_row").size()
        out.loc[out.index[cnt.index.values], "missed_followups_12m"] = cnt.values.astype(float)
    return out
