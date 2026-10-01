"""Model evaluation (SPEC §13.8): AUROC, AUPRC, Brier, ECE, sensitivity at 90% specificity, PPV/NNS at top 2%,
lead time, subgroups, curves."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, precision_recall_curve, roc_auc_score, roc_curve


def ece(y, p, bins: int = 10) -> float:
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(e)


def metrics(y: np.ndarray, p: np.ndarray, top_pct: float = 2.0) -> dict:
    y = np.asarray(y).astype(int)
    p = np.asarray(p, float)
    if y.sum() == 0 or y.sum() == len(y):
        return {"auroc": None, "auprc": None, "brier": None, "ece": None, "sens_at_spec90": None, "ppv_at_top2pct": None,
                "nns_at_top2pct": None, "n_pos": int(y.sum()), "n_neg": int(len(y) - y.sum())}
    fpr, tpr, _ = roc_curve(y, p)
    sens90 = float(np.interp(0.10, fpr, tpr))
    k = max(1, int(round(len(p) * top_pct / 100)))
    top = np.argsort(-p)[:k]
    ppv = float(y[top].mean())
    pmin, pmax = p.min(), p.max()
    pp = (p - pmin) / (pmax - pmin) if pmax > 1 or pmin < 0 else p
    return {"auroc": float(roc_auc_score(y, p)), "auprc": float(average_precision_score(y, p)),
            "brier": float(brier_score_loss(y, np.clip(pp, 0, 1))), "ece": ece(y, np.clip(pp, 0, 1)),
            "sens_at_spec90": sens90, "ppv_at_top2pct": ppv, "nns_at_top2pct": (1 / ppv) if ppv > 0 else None,
            "n_pos": int(y.sum()), "n_neg": int(len(y) - y.sum())}


def curves(model_id: str, y, p) -> list[dict]:
    y = np.asarray(y).astype(int)
    p = np.asarray(p, float)
    out = []
    if 0 < y.sum() < len(y):
        fpr, tpr, _ = roc_curve(y, p)
        sel = np.unique(np.linspace(0, len(fpr) - 1, min(200, len(fpr))).astype(int))
        out += [{"model_id": model_id, "curve": "roc", "x": float(fpr[i]), "y": float(tpr[i])} for i in sel]
        pr, rc, _ = precision_recall_curve(y, p)
        sel = np.unique(np.linspace(0, len(pr) - 1, min(200, len(pr))).astype(int))
        out += [{"model_id": model_id, "curve": "pr", "x": float(rc[i]), "y": float(pr[i])} for i in sel]
        if 0 <= p.min() and p.max() <= 1:
            q = np.quantile(p, np.linspace(0, 1, 11))
            idx = np.clip(np.searchsorted(q, p, side="right") - 1, 0, 9)
            for b in range(10):
                m = idx == b
                if m.any():
                    out.append({"model_id": model_id, "curve": "calibration", "x": float(p[m].mean()), "y": float(y[m].mean())})
    return out


def lead_time(test: pd.DataFrame, score_col: str, threshold: float, model_id: str) -> tuple[dict, list[dict]]:
    """For test-period cases: earliest monthly landmark flagged HIGH (score >= threshold) before dx."""
    cases = test[test["dx_date"].notna()].copy()
    cases["flag"] = cases[score_col] >= threshold
    cases["days_before"] = (pd.to_datetime(cases["dx_date"]) - pd.to_datetime(cases["L"])).dt.days
    cases = cases[(cases["days_before"] > 0) & (cases["days_before"] <= 365 * 2)]
    first = cases[cases["flag"]].groupby("patient_id")["days_before"].max()
    n_cases = cases["patient_id"].nunique()
    lt = first.reindex(cases["patient_id"].unique()).fillna(0)
    out = {"median_lead_time_days": float(first.median()) if len(first) else 0.0,
           "pct_flagged_ge_90d": float(100 * (lt >= 90).mean()) if n_cases else 0.0,
           "pct_flagged_ever": float(100 * len(first) / n_cases) if n_cases else 0.0}
    hist = np.histogram(first.values / 30.44, bins=np.arange(0, 25, 1))[0] if len(first) else np.zeros(24)
    curve = [{"model_id": model_id, "curve": "lead_time", "x": float(i), "y": float(c)} for i, c in enumerate(hist)]
    return out, curve


def subgroups(model_id: str, df: pd.DataFrame, score_col: str, threshold: float) -> list[dict]:
    rows = []
    sg = {"sex": df["sex_male"].map({1: "M", 0: "F"}),
          "age_band": pd.cut(df["age"], [0, 50, 65, 200], right=False, labels=["<50", "50-64", "65+"]).astype(str),
          "province": df["province_code"].fillna("unknown"), "facility_tier": df["home_facility_tier"].fillna("unknown"),
          # the clinically relevant triage population: patients seen with GI complaints in the last 90 days (D-32)
          "recent_gi_visit": pd.Series(np.where(df["days_since_last_gi_visit"].fillna(1e9) <= 90, "seen <=90 d", "not seen <=90 d"),
                                       index=df.index)}
    for var, vals in sg.items():
        for v in sorted(vals.unique()):
            m = (vals == v).values
            y = df.loc[m, "label"].astype(int).values
            p = df.loc[m, score_col].values
            if y.sum() >= 3 and y.sum() < len(y):
                flagged = p >= threshold
                rows.append({"model_id": model_id, "subgroup_var": var, "subgroup_value": str(v),
                             "auroc": float(roc_auc_score(y, p)), "sens": float(flagged[y == 1].mean()),
                             "ppv": float(y[flagged].mean()) if flagged.any() else None, "n": int(m.sum()), "n_pos": int(y.sum())})
    return rows
