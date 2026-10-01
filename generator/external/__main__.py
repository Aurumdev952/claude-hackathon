"""python -m generator.external [--out DIR] -> registry_incidence, risk_factor_surveys, population_projections Parquet.

Default output is $DATA_DIR/external (data/external). Deterministic for a given generator seed.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import polars as pl

from shared.config import DATA_DIR, generator_cfg

from . import population, registry, surveys
from .model import ext_cfg


def build_all(out: Path, log=print) -> dict:
    t0 = time.time()
    gen, cfg = generator_cfg(), ext_cfg()
    rng = np.random.default_rng(int(gen["seed"]) + int(cfg.get("seed_offset", 77)))
    out.mkdir(parents=True, exist_ok=True)
    grid = population.build_grid(cfg)
    pop = population.to_frame(grid, cfg)
    reg, h_mult = registry.build(grid, gen, cfg, rng)
    sur = surveys.build(grid, gen, cfg, rng)
    pop.write_parquet(out / "population_projections.parquet")
    reg.write_parquet(out / "registry_incidence.parquet")
    sur.write_parquet(out / "risk_factor_surveys.parquet")
    info = {"rows": {"population_projections": pop.height, "registry_incidence": reg.height,
                     "risk_factor_surveys": sur.height}, "h_mult": round(h_mult, 4),
            "national_population": {y: int(grid[y].sum()) for y in (2000, 2012, 2020, 2025, 2030, 2035)},
            "registered_cases": {int(y): int(c) for y, c in
                                 reg.group_by("year").agg(pl.col("cases").sum()).sort("year").iter_rows()
                                 if y in (2000, 2010, 2015, 2020, 2025)},
            "seconds": round(time.time() - t0, 1)}
    json.dump(info, open(out / "external_meta.json", "w"), indent=1)
    log(json.dumps(info, indent=1))
    return info


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DATA_DIR / "external"))
    build_all(Path(ap.parse_args().out))
