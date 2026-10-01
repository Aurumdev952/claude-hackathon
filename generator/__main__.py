"""python -m generator --scale 0.05 --seed 42 [--load-mysql]   (SPEC §8.11)"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import multiprocessing as mp
import os
import shutil
import time

import numpy as np
import polars as pl

from shared.config import BULK_DIR, DATA_DIR, LATENT_DIR, REF_DIR, generator_cfg
from shared.geo import DISTRICT_CODES

from . import life
from .context import HIST_END, SIM_END
from .dates import to_date
from .diseases.gastric_cancer import calibrate_h_mult
from .facilities import build_facilities, facility_events
from .ground_truth import denominators, write_ground_truth
from .population import build_population
from .quality import apply_noise
from .reference_tables import build as build_reference
from .writers import chunk_frames, finalize_future, write_chunk


def _worker(args):
    chunk, lo, hi = args
    out = life.run_chunk(chunk, lo, hi)
    cfg, facs, seed = life.SHARED["cfg"], life.SHARED["facs"], life.SHARED["seed"]
    out = apply_noise(out, cfg, facs, seed + chunk)
    F = chunk_frames(out, chunk, seed)
    write_chunk(F, BULK_DIR, chunk)
    counts = {k: v.height for k, v in F.items()}
    return {"chunk": chunk, "latent_cases": out["latent_cases"], "noise": out["noise_log"], "counts": counts,
            "deaths": out.get("deaths", [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=float)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--load-mysql", action="store_true")
    ap.add_argument("--h-mult", type=float, help="override calibrated baseline hazard multiplier")
    a = ap.parse_args()
    cfg = generator_cfg()
    if a.scale is not None:
        cfg["scale"] = a.scale
    if a.seed is not None:
        cfg["seed"] = a.seed
    seed = int(cfg["seed"])
    t0 = time.time()
    if BULK_DIR.exists():
        shutil.rmtree(BULK_DIR)
    LATENT_DIR.mkdir(parents=True, exist_ok=True)

    facs = build_facilities(cfg, seed)
    P = build_population(cfg, facs, seed)
    h_mult = a.h_mult or calibrate_h_mult(P, cfg) * float(cfg["gastric_cancer"].get("h0_multiplier", 1.0))
    n = len(P["person_id"])
    print(f"population {n:,}  facilities {len(facs)}  h_mult={h_mult:.4f}  ({time.time() - t0:.1f}s)")
    names = collections.defaultdict(list)
    for r in csv.DictReader(open(REF_DIR / "names_rw.csv")):
        names[r["type"]].append(r["name"])
    sectors = json.load(open(REF_DIR / "sectors.json"))
    life.SHARED.update(P=P, facs=facs, cfg=cfg, seed=seed, h_mult=h_mult, names=dict(names), sectors=sectors)

    cs = int(cfg["population"].get("chunk_size", 25000))
    jobs = [(k, lo, min(n, lo + cs)) for k, lo in enumerate(range(0, n, cs))]
    results = []
    ctx = mp.get_context("fork")
    with ctx.Pool(min(a.workers, len(jobs))) as pool:
        for r in pool.imap_unordered(_worker, jobs):
            results.append(r)
            print(f"  chunk {r['chunk']:3d} done: {r['counts']['obs']:,} obs, {len(r['latent_cases'])} cancers "
                  f"({time.time() - t0:.0f}s)")
    fut = finalize_future(BULK_DIR)
    print(f"future rows: {fut['future_rows']}")

    # reference tables (parquet for DuckDB bootstrap; MySQL loader inserts them directly)
    ref = build_reference(facs)
    for name, df in ref.items():
        p = BULK_DIR / "parquet" / name
        p.mkdir(parents=True, exist_ok=True)
        df.write_parquet(p / "part-0000.parquet")

    # facilities + events reference
    fac_df = pl.DataFrame([{**{k: v for k, v in f.items() if k not in ("go_live", "endoscopy_from")},
                            "go_live_date": to_date(f["go_live"]).isoformat(),
                            "endoscopy_from_date": to_date(f["endoscopy_from"]).isoformat() if f["endoscopy_from"] else None,
                            "endoscopy_from_year": to_date(f["endoscopy_from"]).year if f["endoscopy_from"] else None}
                           for f in facs])
    fac_df.write_csv(REF_DIR / "facilities.csv")
    ev = pl.DataFrame([{**e, "event_date": to_date(e["event_date"]).isoformat()} for e in facility_events(facs)])
    ev.write_csv(REF_DIR / "facility_events.csv")

    # latent layer
    cases = [c for r in results for c in r["latent_cases"]]
    cases_df = pl.DataFrame(cases, infer_schema_length=None) if cases else pl.DataFrame()
    cases_df.write_parquet(LATENT_DIR / "gastric_cases.parquet")
    death = P["death"].copy()
    pid_to_i = {int(p): i for i, p in enumerate(P["person_id"])}
    for c in cases:
        if c["death_day"] is not None:
            death[pid_to_i[c["person_id"]]] = min(death[pid_to_i[c["person_id"]]], c["death_day"])
    latent_persons = pl.DataFrame({
        "person_id": P["person_id"], "sex": np.where(P["sex"] == 1, "M", "F"), "birth_day": P["birth"],
        "death_day": death, "district_code": [DISTRICT_CODES[i] for i in P["district_idx"]],
        "district2_code": [DISTRICT_CODES[i] for i in P["district2_idx"]], "move_day": P["move_day"],
        "emr_start": P["emr_start"], "home_facility": P["home"], "hp": P["hp"], "hiv": P["hiv"], "hot": P["hot"],
        "micro": P["micro"], "tobacco": P["tobacco"], "family_hx": P["family_hx"], "salt": P["salt"], "smoked": P["smoked"]})
    latent_persons.write_parquet(LATENT_DIR / "persons.parquet")
    noise = collections.Counter()
    dups = []
    for r in results:
        for k, v in r["noise"].items():
            if k == "duplicates":
                dups.extend(v)
            else:
                noise[k] += v
    json.dump({"counts": dict(noise), "duplicates": dups}, open(LATENT_DIR / "noise_log.json", "w"))

    denom = denominators(P, death, SIM_END)  # full-year person-time; the pipeline pro-rates the current sim year
    denom.write_csv(REF_DIR / "district_population.csv")

    tot = collections.Counter()
    for r in results:
        tot.update(r["counts"])
    status = collections.Counter(c["status"] for c in cases if c["dx_day"] is None or c["dx_day"] <= HIST_END)
    n_hist = sum(1 for c in cases if c["onset_day"] <= HIST_END)
    counts = {"population": n, "patients": int(tot["patient"]), "true_gastric_cancers": n_hist,
              "confirmed_cases": status.get("CONFIRMED", 0), "probable_cases": status.get("PROBABLE", 0),
              "undiagnosed_cases": sum(1 for c in cases if c["onset_day"] <= HIST_END and
                                       (c["dx_day"] is None or c["dx_day"] > HIST_END)),
              "rows_incl_future": dict(tot), "duplicates_planted": len(dups), "h_mult": h_mult}
    write_ground_truth(DATA_DIR / "ground_truth.json", cfg, seed, counts, cases_df, str(P["_micro_sector_name"][0]))
    print(json.dumps({k: v for k, v in counts.items() if k != "rows_incl_future"}, indent=1))
    print(f"generation done in {time.time() - t0:.0f}s")
    if a.load_mysql:
        from .loader import load_all
        load_all(BULK_DIR, ref)


if __name__ == "__main__":
    main()
