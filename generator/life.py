"""Chunk worker: simulates each patient's life and returns OpenMRS rows + latent truth (SPEC §8.11 step 3)."""
from __future__ import annotations

import random
import uuid

import numpy as np

from shared.geo import DISTRICTS

from .context import MIN_PER_DAY, SIM_END, START, Ctx
from .dates import d
from .diseases.background import record_death, simulate_background
from .diseases.gastric_cancer import hazard_matrix, sample_onset, simulate_cancer
from .diseases.gi import simulate_gi
from .emit import Recorder
from .patient import Patient

OPENMRS_ALPHABET = "0123456789ACDEFGHJKLMNPRTUVWXY"

# Populated in the parent before forking (workers inherit it, no pickling of big arrays)
SHARED: dict = {}


def luhn_mod30(s: str) -> str:
    n = len(OPENMRS_ALPHABET)
    factor, total = 2, 0
    for ch in reversed(s):
        code = OPENMRS_ALPHABET.index(ch)
        add = factor * code
        factor = 1 if factor == 2 else 2
        total += add // n + add % n
    return OPENMRS_ALPHABET[(n - total % n) % n]


def openmrs_id(prefix: str, pid: int) -> str:
    seq = f"{pid:07d}"[-7:]
    return f"{prefix}-{seq}{luhn_mod30(seq)}"


def run_chunk(chunk_idx: int, lo: int, hi: int) -> dict:
    P, facs, cfg, seed, h_mult, names, sectors = (SHARED[k] for k in ("P", "facs", "cfg", "seed", "h_mult", "names", "sectors"))
    ctx = Ctx(cfg, facs)
    rec = Recorder(chunk_idx, ctx.go_live)
    idx = np.arange(lo, hi)
    H, RRHP = hazard_matrix(P, idx, cfg, h_mult)
    latent_cases = []
    patients: dict[int, Patient] = {}
    for k, i in enumerate(idx):
        p = Patient(P, int(i))
        rnd = random.Random(seed * 1_000_003 + p.pid)
        w0 = max(p.birth, START)
        w1 = min(p.death, SIM_END)
        rec.begin_patient(p.pid, p.emr_start)
        if w1 > w0:
            simulate_gi(p, ctx, rec, w0, w1, rnd)
            onset = sample_onset(H[k], rnd, p.hp_erad_day, RRHP[k], cfg["gastric_cancer"]["rr"]["hp_eradicated_floor"])
            if onset is not None and onset < p.death and onset <= SIM_END and onset >= p.birth + 18 * 365:
                latent_cases.append(simulate_cancer(p, ctx, rec, onset, rnd))
            simulate_background(p, ctx, rec, w0, min(p.death, SIM_END), rnd)
            if p.death <= SIM_END:
                cause = p.died_of
                if p.cancer is not None and p.cancer.dx_day is None and p.died_of is None:
                    cause = None
                record_death(p, ctx, rec, rnd, cause=cause)
            rec.truncate_patient(min(p.death, SIM_END) * MIN_PER_DAY + 1439)
        if p.pid in rec.first_enc:
            patients[p.pid] = p
    person_rows = build_person_rows(patients, rec, facs, names, sectors, seed + chunk_idx)
    return {"chunk": chunk_idx, "rec": {
        "visits": rec.visits, "encs": rec.encs, "obs": rec.obs_rows, "orders": rec.orders,
        "drug_orders": rec.drug_orders, "programs": rec.programs}, "persons": person_rows,
        "latent_cases": latent_cases, "first_enc": rec.first_enc}


def build_person_rows(patients: dict[int, Patient], rec: Recorder, facs, names, sectors, seed: int) -> dict:
    rnd = random.Random(seed * 7919)
    by_id = {f["location_id"]: f for f in facs}
    person, pname, addr, attr, patient, ident = [], [], [], [], [], []
    for pid, p in patients.items():
        t0 = rec.first_enc[pid]
        sex = "M" if p.male else "F"
        dead_day = p.death if (p.death_enc and p.death <= SIM_END) else None
        person.append((pid, sex, p.birth, 0, 1 if dead_day else 0, dead_day, p.died_of if dead_day else None, t0))
        given = rnd.choice(names["given_m" if p.male else "given_f"])
        family = rnd.choice(names["family"])
        pname.append((pid, given, family, t0))
        s1 = sectors[p.sector_idx]
        f1 = by_id[p.home]
        addr.append((pid, 1, DISTRICTS[p.district][1], s1["sector"], PROV_FULL[p.province],
                     round(s1["centroid"][1] + rnd.gauss(0, 0.01), 5), round(s1["centroid"][0] + rnd.gauss(0, 0.01), 5),
                     t0, p.move_day * MIN_PER_DAY if p.move_day < 10**6 else None, t0))
        if p.move_day < 10**6 and p.move_day <= SIM_END and p.move_day * MIN_PER_DAY > t0:
            s2 = sectors[int(SHARED["P"]["sector2_idx"][p.i])]
            addr[-1] = addr[-1][:1] + (0,) + addr[-1][2:]
            addr.append((pid, 1, DISTRICTS[p.district2][1], s2["sector"], PROV_FULL[DISTRICTS[p.district2][0]],
                         round(s2["centroid"][1] + rnd.gauss(0, 0.01), 5), round(s2["centroid"][0] + rnd.gauss(0, 0.01), 5),
                         p.move_day * MIN_PER_DAY, None, p.move_day * MIN_PER_DAY))
        else:
            addr[-1] = addr[-1][:8] + (None,) + addr[-1][9:]
        if rnd.random() < 0.7:
            attr.append((pid, f"+250 7{rnd.randint(2, 9)}{rnd.randint(0, 9)} {rnd.randint(100, 999)} {rnd.randint(100, 999)}", 1, t0))
        attr.append((pid, str(rnd.choices([1, 2, 3, 4], [0.16, 0.30, 0.53, 0.01])[0]), 2, t0))
        attr.append((pid, rnd.choices(["CBHI", "RAMA", "MMI", "Private", "None"], [0.82, 0.07, 0.03, 0.03, 0.05])[0], 3, t0))
        patient.append((pid, t0))
        ident.append((pid, openmrs_id(f1["prefix"], pid), 1, 1, f1["location_id"], t0))
        ident.append((pid, "SYN" + "".join(str(rnd.randint(0, 9)) for _ in range(13)), 2, 0, None, t0))
    return {"person": person, "person_name": pname, "person_address": addr, "person_attribute": attr,
            "patient": patient, "patient_identifier": ident}


PROV_FULL = {"KGL": "City of Kigali", "NOR": "Northern Province", "SOU": "Southern Province",
             "EAS": "Eastern Province", "WES": "Western Province"}


def make_uuid(rnd: random.Random) -> str:
    return str(uuid.UUID(int=rnd.getrandbits(128), version=4))
