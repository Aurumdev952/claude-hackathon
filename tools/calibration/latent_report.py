"""Summarise the latent gastric cancer cases against SPEC §8.8 / §9 targets (used while tuning the generator)."""
from __future__ import annotations

import json

import numpy as np
import polars as pl

from shared.config import LATENT_DIR, DATA_DIR, REF_DIR
from generator.dates import d

HIST_END = d("2026-06-30")
cases = pl.read_parquet(LATENT_DIR / "gastric_cases.parquet")
facs = pl.read_csv(REF_DIR / "facilities.csv").select("location_id", "hp_testing_tier")
cases = cases.join(facs.rename({"location_id": "first_gi_loc", "hp_testing_tier": "tier"}), on="first_gi_loc", how="left")
c = cases.filter(pl.col("onset_day") <= d("2025-06-30"))
dx = c.filter(pl.col("dx_day").is_not_null() & (pl.col("dx_day") <= HIST_END) & (pl.col("dx_day") >= pl.col("emr_start")))
print("cases onset<=2025-06:", c.height, " status:", dict(c.group_by("status").len().iter_rows()))
print("recorded dx (in EMR, <= hist end):", dx.height, dict(dx.group_by("status").len().iter_rows()))
sd = dx.group_by("stage").len().sort("stage")
print("stage mix:", {r[0]: round(100 * r[1] / dx.height, 1) for r in sd.iter_rows()})
age = (dx["dx_day"] - dx["birth_day"]) / 365.25
print("median age at dx:", round(float(age.median()), 1), " M:F", round(dx["male"].sum() / max(1, (~dx["male"]).sum()), 2))
print("lauren:", {r[0]: round(100 * r[1] / dx.height) for r in dx.group_by("lauren").len().iter_rows()})
iv = (dx["dx_day"] - dx["first_gi_day"]) / 30.44
print("diag interval months median:", round(float(iv.median()), 1), " IQR", round(float(iv.quantile(0.25)), 1), round(float(iv.quantile(0.75)), 1))
print("% >=3 symptomatic visits:", round(100 * (dx["n_symptomatic_visits"] >= 3).mean(), 1))
for t in ("low", "medium", "high"):
    s = dx.filter(pl.col("tier") == t)
    if s.height:
        print(f"  tier {t}: n={s.height} stage IV {100 * (s['stage'] == 'IV').mean():.0f}%")
young = dx.filter(((pl.col("dx_day") - pl.col("birth_day")) / 365.25) < 50)
if young.height:
    print(f"young (<50) n={young.height}: female {100 * (~young['male']).mean():.0f}%  diffuse {100 * (young['lauren'] == 'diffuse').mean():.0f}%"
          f"  HP- {100 * (~young['hp']).mean():.0f}%  stage IV {100 * (young['stage'] == 'IV').mean():.0f}%")
old = dx.filter(((pl.col("dx_day") - pl.col("birth_day")) / 365.25) >= 50)
print(f"old female {100 * (~old['male']).mean():.0f}% diffuse {100 * (old['lauren'] == 'diffuse').mean():.0f}% HP- {100 * (~old['hp']).mean():.0f}%")
es = dx.filter(pl.col("province").is_in(["EAS", "SOU"]))
ot = dx.filter(~pl.col("province").is_in(["EAS", "SOU"]))
print("INS-6 interval EAS/SOU vs other:", round(float(((es["dx_day"] - es["first_gi_day"]) / 30.44).median()), 1),
      round(float(((ot["dx_day"] - ot["first_gi_day"]) / 30.44).median()), 1), " misattrib>0:", round(100 * (es["misattributions"] > 0).mean()))
for t in ("low", "medium", "high"):
    s_ = dx.filter(pl.col("tier") == t)
    if s_.height:
        print(f"  tier {t} 1y survival {100 * ((s_['death_day'].fill_null(10**7) - s_['dx_day']) > 365).mean():.0f}%")
early = c.filter(pl.col("symptom_start_day") <= d("2025-01-01"))
died_undx = early.filter(pl.col("dx_day").is_null() & pl.col("death_day").is_not_null() & (pl.col("death_day") >= pl.col("symptom_start_day")))
print(f"died with symptoms undiagnosed: {100 * died_undx.height / max(1, early.height):.1f}% (target 6%)")
print(f"probable share of diagnosed: {100 * (dx['status'] == 'PROBABLE').mean():.0f}% (target 12%)")
surv = dx.with_columns(((pl.col("death_day").fill_null(10**7) - pl.col("dx_day")) > 365).alias("s1"))
print("1y survival:", round(100 * surv["s1"].mean(), 1))
und = c.filter(pl.col("dx_day").is_null())
print("undiagnosed:", und.height, "died before symptoms:", (und["death_day"].fill_null(10**7) < und["symptom_start_day"]).sum(),
      " never referred:", (und["referrals"] == 0).sum(), " refused>0:", (und["refused"] > 0).sum())
by_year = dx.with_columns(((pl.col("dx_day") / 365.25) + 1970).floor().cast(pl.Int32).alias("y")).group_by("y").len().sort("y")
print("dx by year:", dict(by_year.iter_rows()))
rus = dx.filter(pl.col("district_dx") == "WES-RUS").with_columns(((pl.col("dx_day") / 365.25) + 1970).floor().cast(pl.Int32).alias("y"))
print("RUS dx by year:", dict(rus.group_by("y").len().sort("y").iter_rows()))

print("route x stage IV:")
for r in dx.group_by("route").agg(pl.len().alias("n"), (pl.col("stage") == "IV").mean().alias("iv")).sort("n", descending=True).iter_rows():
    print("  ", r)
print(dx.group_by("tier", "route").len().sort("tier", "route"))
