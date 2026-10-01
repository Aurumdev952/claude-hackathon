"""Tier 1 transparent points score (SPEC §13.5). Designed a priori - NOT fitted."""
from __future__ import annotations

import numpy as np
import pandas as pd

from shared.config import models_cfg


def points(df: pd.DataFrame) -> np.ndarray:
    age = df["age"].values
    p = np.select([age >= 60, age >= 50, age >= 40], [3, 2, 1], 0)
    p += (df["sex_male"].values == 1).astype(int)
    p += 2 * (df["n_gi_visits_12m"].values >= 3)
    p += 3 * (df["n_alarm_features_12m"].values >= 1)
    hb_drop = np.nan_to_num(df["hb_drop_12m"].values.astype(float), nan=0.0) >= 1.5
    anaemia_unexplained = (np.nan_to_num(df["anaemia_flag"].values.astype(float)) == 1) & (df["malaria_dx_12m_while_anaemic"].values == 0) \
        & (df["helminth_dx_12m_while_anaemic"].values == 0)
    p += 3 * (hb_drop | anaemia_unexplained)
    p += 2 * (np.nan_to_num(df["weight_change_pct_6m"].values.astype(float), nan=0.0) <= -5)
    p += 2 * (df["ppi_courses_without_resolution"].values == 1)
    p += 2 * (df["hp_pos_untreated"].values == 1)
    p += 2 * (df["family_hx"].values == "yes")
    p += 1 * (df["tobacco"].values == "current")
    return p.astype(int)


def band(score: np.ndarray) -> np.ndarray:
    b = models_cfg()["tier1"]["bands"]
    return np.where(score >= b["high"][0], "HIGH", np.where(score >= b["medium"][0], "MEDIUM", "LOW"))


def reasons(row: pd.Series) -> list[dict]:
    out = []
    if row["n_alarm_features_12m"] >= 1:
        out.append(("Alarm feature in 12 months", 3))
    if (row.get("hb_drop_12m") or 0) >= 1.5:
        out.append((f"Haemoglobin fell {row['hb_drop_12m']:.1f} g/dL in 12 months", 3))
    if row["n_gi_visits_12m"] >= 3:
        out.append((f"{row['n_gi_visits_12m']:.0f} stomach-complaint visits in 12 months", 2))
    if row["hp_pos_untreated"] == 1:
        out.append(("H. pylori positive, untreated", 2))
    return [{"label": t, "points": p} for t, p in out]
