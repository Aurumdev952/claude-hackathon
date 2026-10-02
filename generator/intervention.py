"""Re-simulate a patient's course from a care-driven endoscopy (v3 plan §1c, docs/contracts/v3-loop.md §2).

`resimulate_from_endoscopy(person_id, endo_day, site_location_id, *, seed)` returns `(rows, latent_update)`:

- **Latent cancer present at `endo_day`, not yet diagnosed** (onset <= endo_day < original dx/death): the generator's own
  `_diagnose` -> `_oncology` -> `_survival` run from `endo_day`. The stage comes from `CaseState.stage_at(day)`, so an
  earlier endoscopy finds an earlier stage, which raises the curative probability (`p_curative`) and survival. The
  patient's pre-simulated future from `endo_day` is superseded (`care.emr` supersede record) and replaced by the rows
  returned here, death record included.
- **Cancer already diagnosed**: a surveillance endoscopy (indication 7104). No supersede.
- **No latent cancer at that date**: a normal, gastritis or atrophy/IM endoscopy with a rapid urease test from the latent
  H. pylori status (biopsy -> pathology sometimes). No supersede.

How the Patient is rebuilt: `Patient` is a plain attribute holder, so it is rebuilt field by field from
`data/bulk/latent/persons.parquet` (sex, birth, districts, home facilities, H. pylori, trajectories: hb_base, height,
bmi) and `gastric_cases.parquet` (onset, symptom start, stage durations `stage_months`, Lauren type, location, Hb/weight
decline parameters, background death `bg_death_day`, per-case seed). `Ctx` comes from `reference/facilities.csv`. The
generator functions then run unchanged, recording into a `care.emr_rows.CareRecorder` (care id range). Datasets
generated before v3 lack hb_base/height/bmi and the case fields: sex means and a re-drawn sojourn are used then
(a faithful lightweight equivalent with the same stage, TNM, intent and survival formulas).

Ids: the EMR patient id is used for rows. Persons first seen after the history end were renumbered by
`generator/writers.py:finalize_future`; `_person_id_map.parquet` maps them back to the latent person id.
"""
from __future__ import annotations

import datetime as dt
import random
from functools import lru_cache
from pathlib import Path

import polars as pl

from shared.concepts import C
from shared.geo import DISTRICTS

from .context import MIN_PER_DAY, SIM_END, Ctx
from .dates import d as day_of
from .diseases.background import record_death
from .diseases.base import clinic_time
from .diseases.gastric_cancer import STAGES, CaseState, _diagnose, case_seed, p_curative
from .patient import Patient

FAR = dt.datetime(2100, 1, 1)


# ----------------------------------------------------------------------------------------------- latent look-ups
def _paths():
    from shared import config
    return config.LATENT_DIR, config.REF_DIR, config.BULK_DIR


def _mtime(p: Path) -> float:
    return p.stat().st_mtime if p.exists() else 0.0


@lru_cache(maxsize=4)
def _persons(path: str, _m: float) -> pl.DataFrame:
    return pl.read_parquet(path)


@lru_cache(maxsize=4)
def _cases(path: str, _m: float) -> pl.DataFrame:
    return pl.read_parquet(path) if Path(path).exists() else pl.DataFrame()


@lru_cache(maxsize=4)
def _pid_map(path: str, _m: float) -> dict[int, int]:
    if not Path(path).exists():
        return {}
    m = pl.read_parquet(path)
    return dict(zip(m["new"].to_list(), m["old"].to_list()))


@lru_cache(maxsize=4)
def _ctx(path: str, _m: float) -> Ctx:
    from shared.config import generator_cfg
    fac = pl.read_csv(path)
    facs = []
    for r in fac.iter_rows(named=True):
        f = dict(r)
        f["go_live"] = day_of(str(r["go_live_date"]))
        f["endoscopy_from"] = day_of(str(r["endoscopy_from_date"])) if r["endoscopy_from_date"] else None
        facs.append(f)
    return Ctx(generator_cfg(), facs)


def latent_tables():
    latent, ref, bulk = _paths()
    pp, cp = latent / "persons.parquet", latent / "gastric_cases.parquet"
    mp, fp = bulk / "future" / "_person_id_map.parquet", ref / "facilities.csv"
    return (_persons(str(pp), _mtime(pp)), _cases(str(cp), _mtime(cp)), _pid_map(str(mp), _mtime(mp)),
            _ctx(str(fp), _mtime(fp)))


def latent_person_id(patient_id: int) -> int:
    return int(latent_tables()[2].get(int(patient_id), int(patient_id)))


def latent_case(patient_id: int) -> dict | None:
    _, cases, _, _ = latent_tables()
    if cases.height == 0:
        return None
    r = cases.filter(pl.col("person_id") == latent_person_id(patient_id))
    return r.row(0, named=True) if r.height else None


def latent_person(patient_id: int) -> dict | None:
    persons = latent_tables()[0]
    r = persons.filter(pl.col("person_id") == latent_person_id(patient_id))
    return r.row(0, named=True) if r.height else None


# ----------------------------------------------------------------------------------------------- rebuild
def rebuild_patient(pr: dict, case: dict | None, emr_patient_id: int) -> Patient:
    p = Patient.__new__(Patient)
    p.i, p.pid = -1, int(emr_patient_id)
    p.male = pr["sex"] == "M"
    p.birth = int(pr["birth_day"])
    p.district, p.district2 = pr["district_code"], pr["district2_code"]
    p.province = DISTRICTS[p.district][0]
    p.sector_idx = -1
    p.home, p.home2 = int(pr["home_facility"]), int(pr.get("home2") or pr["home_facility"])
    p.move_day, p.emr_start = int(pr["move_day"]), int(pr["emr_start"])
    for k in ("hp", "hiv", "hot", "micro", "family_hx", "salt", "smoked"):
        setattr(p, k, bool(pr[k]))
    p.alcohol_heavy, p.nsaid = bool(pr.get("alcohol_heavy") or False), bool(pr.get("nsaid") or False)
    p.htn = p.dm = False
    p.tobacco = int(pr["tobacco"])
    p.alcohol = C.CURRENT if p.alcohol_heavy else C.NEVER
    p.atrophy_day = int(pr.get("atrophy_day") or 10**7)
    p.hiv_dx = p.htn_dx = p.dm_dx = 10**7
    p.water, p.fuel, p.occupation, p.fruit_veg = 7061, 7050, 7070, 3.0
    p.hb_base = float(pr.get("hb_base") or (14.6 if p.male else 13.1))
    p.height = float(pr.get("height") or (168.0 if p.male else 157.0))
    p.bmi = float(pr.get("bmi") or 21.8)
    p.initial_done, p.lifestyle_recorded = True, {}
    p.cancer, p.died_of, p.death_recorded, p.death_enc, p.death_traced = None, None, False, False, False
    p.hb_stop = p.wt_stop = p.wt_post = None
    p.hb_decline = p.wt_loss = None
    p.hp_erad_day = None
    p.death = int(pr["death_day"]) if pr["death_day"] is not None and pr["death_day"] < 10**6 else 10**7
    if case:
        p.hp_erad_day = case.get("hp_eradicated_day")
        if case.get("hb_decline_start") is not None:
            p.hb_decline = (int(case["hb_decline_start"]), float(case["hb_decline_rate"]))
        if case.get("wt_loss_start") is not None:
            p.wt_loss = (int(case["wt_loss_start"]), float(case["wt_loss_rate"]))
        bg = case.get("bg_death_day")
        p.death = int(bg) if bg is not None else 10**7   # non-cancer death; the re-simulated cancer sets its own
    return p


def rebuild_case(case: dict, cfg: dict, rnd: random.Random) -> CaseState:
    cs = CaseState()
    cs.onset, cs.symptom_start = int(case["onset_day"]), int(case["symptom_start_day"])
    cs.young, cs.lauren, cs.location = bool(case["young_at_onset"]), case["lauren"], case["location"]
    sm = case.get("stage_months")
    if sm is None:  # pre-v3 dataset: re-draw the stage durations from the same distribution
        speed = 0.72 if (cs.young or cs.lauren == "diffuse") else 1.0
        sm = [rnd.gammavariate(2.0, m / 2.0) * speed for m in cfg["gastric_cancer"].get("stage_months", [5, 5, 6])]
    cs.durs = [float(x) for x in sm]
    cs.sojourn_m = case.get("sojourn_months")
    cs.seed = int(case.get("case_seed") or case_seed(cfg, int(case["person_id"])))
    cs.bg_death = case.get("bg_death_day")
    cs.surv = None
    cs.clinical_only = False  # the endoscopy happens: tissue diagnosis
    cs.ramp = cs.ppi_repeat = cs.mis_prone = False
    cs.alarm_late, cs.hb_drop, cs.wt_loss = bool(case.get("alarm_late")), bool(case.get("hb_drop")), bool(case.get("wt_loss"))
    cs.dx_day = cs.stage = cs.dx_loc = cs.dx_code = cs.district_dx = cs.death_ca = cs.treatment = None
    cs.status, cs.route = "UNDIAGNOSED", "care_pathway"
    cs.first_gi_loc, cs.first_gi_day = case.get("first_gi_loc"), case.get("first_gi_day")
    cs.first_rec_gi_day = case.get("first_rec_gi_day")
    cs.n_visits, cs.misattrib, cs.referrals, cs.refused = int(case.get("n_symptomatic_visits") or 0), 0, 1, 0
    cs.first_mis_day = None
    cs.undiagnosed = False
    return cs


def _builder(sim_time, adapter):
    from care.emr_rows import EMRBuilder
    return EMRBuilder(sim_time, adapter=adapter) if adapter is not None else EMRBuilder(sim_time)


# ----------------------------------------------------------------------------------------------- endoscopy outcomes
def _benign(p: Patient, rec, day: int, site: int, rnd: random.Random, indication: int) -> dict:
    t = clinic_time(day, rnd)
    enc = rec.encounter(t, "ENDOSCOPY", site)
    g = rec.obs(enc, t, site, C.ENDO_SET)
    rec.coded(enc, t, site, C.ENDO_INDICATION, indication, group=g)
    atrophy = p.atrophy_day <= day
    infected = p.hp and (p.hp_erad_day is None or day < p.hp_erad_day)
    imp = 7114 if atrophy else (7111 if (infected and rnd.random() < 0.7) or rnd.random() < 0.3 else 7110)
    rec.coded(enc, t, site, C.ENDO_IMPRESSION, imp, group=g)
    rut = C.POS if (infected and rnd.random() < 0.9) else C.NEG
    rec.coded(enc, t, site, C.RUT, rut, group=g)
    biopsy = rnd.random() < (0.8 if atrophy else 0.35)
    rec.coded(enc, t, site, C.BIOPSY, C.YES if biopsy else C.NO, group=g)
    finding = {7114: "ATROPHY_IM", 7111: "GASTRITIS", 7110: "NORMAL"}[imp]
    if infected and imp != 7114:
        rec.dx(enc, t + 30, site, 2019)
    if biopsy:
        pt = t + rnd.randint(7, 28) * MIN_PER_DAY
        penc = rec.encounter(pt, "PATHOLOGY", site)
        pg = rec.obs(penc, pt, site, C.PATH_SET)
        hist = 7132 if atrophy and rnd.random() < 0.7 else 7131
        rec.coded(penc, pt, site, C.HISTOLOGY, hist, group=pg)
        rec.coded(penc, pt, site, C.HP_HISTO, C.POS if infected else C.NEG, group=pg)
        rec.dx(penc, pt + 10, site, 2020 if hist == 7132 else 2011)
        if hist == 7132:
            finding = "INTESTINAL_METAPLASIA"
    return {"finding": finding, "rut": "POSITIVE" if rut == C.POS else "NEGATIVE", "cancer_found": False,
            "endoscopy_encounter_id": enc}


def _surveillance(p: Patient, case: dict, rec, day: int, site: int, rnd: random.Random) -> dict:
    t = clinic_time(day, rnd)
    enc = rec.encounter(t, "ENDOSCOPY", site)
    g = rec.obs(enc, t, site, C.ENDO_SET)
    rec.coded(enc, t, site, C.ENDO_INDICATION, 7104, group=g)
    residual = not case.get("gastrectomy") or (case.get("recurrence_day") is not None and case["recurrence_day"] <= day)
    imp = 7113 if residual else (7111 if rnd.random() < 0.4 else 7110)
    rec.coded(enc, t, site, C.ENDO_IMPRESSION, imp, group=g)
    rec.coded(enc, t, site, C.BIOPSY, C.NO, group=g)
    return {"finding": "KNOWN_CANCER" if residual else "NO_RECURRENCE", "cancer_found": False, "surveillance": True,
            "endoscopy_encounter_id": enc}


def resimulate_from_endoscopy(person_id: int, endo_day: int, site_location_id: int, *, seed: int,
                              sim_time: dt.datetime | None = None, adapter=None, supersede: bool = True,
                              anaemic: bool = False, alarm: bool = False, reason: str = "care pathway endoscopy"
                              ) -> tuple[dict[str, pl.DataFrame], dict]:
    """Rows of the endoscopy (and, for a latent cancer, the whole re-simulated course) + the latent update.

    `person_id` is the EMR patient id. `seed` drives the clinical draws. With `supersede=True` (default) a re-simulated
    cancer course writes the supersede record through `adapter` (default `care.emr.get_adapter()`); the update then
    carries `supersede_seq` for `commit()`."""
    from care import emr
    adapter = adapter or emr.get_adapter()
    pr = latent_person(person_id)
    if pr is None:
        raise KeyError(f"patient {person_id} has no latent person record")
    case = latent_case(person_id)
    _, _, _, ctx = latent_tables()
    rnd = random.Random(int(seed))
    b = _builder(sim_time, adapter)
    rec = b.recorder
    rec.begin_patient(int(person_id), 0)
    p = rebuild_patient(pr, case, int(person_id))
    site = int(site_location_id)
    upd = {"patient_id": int(person_id), "latent_person_id": int(pr["person_id"]), "endo_day": int(endo_day),
           "site_location_id": site, "seed": int(seed), "resimulated": False, "supersede_seq": None,
           "had_latent_cancer": case is not None}
    live_cancer = (case is not None and case["onset_day"] <= endo_day
                   and (case["dx_day"] is None or case["dx_day"] > endo_day)
                   and (case["death_day"] is None or case["death_day"] > endo_day))
    if case is not None and case["dx_day"] is not None and case["dx_day"] <= endo_day:
        upd.update(_surveillance(p, case, rec, endo_day, site, rnd))
    elif not live_cancer:
        upd.update(_benign(p, rec, endo_day, site, rnd, 7103 if anaemic else (7101 if alarm else 7100)))
    else:
        cs = rebuild_case(case, ctx.cfg, rnd)
        p.cancer = cs
        tier = ctx.tier(cs.first_gi_loc) if cs.first_gi_loc else "medium"
        alarms = [2205] if alarm else []
        _diagnose(p, ctx, rec, cs, int(endo_day), site, alarms, anaemic, rnd)
        if p.death <= SIM_END:
            cause = p.died_of
            record_death(p, ctx, rec, rnd, cause=cause, p_record=0.95 if p.death_traced else 0.8)
        rec.truncate_patient(min(p.death, SIM_END) * MIN_PER_DAY + 1439)
        sv = cs.surv or {}
        upd.update({
            "resimulated": True, "cancer_found": True, "finding": "CANCER_FOUND", "status": cs.status,
            "stage": cs.stage, "dx_day": cs.dx_day, "treatment": cs.treatment, "intent": sv.get("intent"),
            "p_curative": round(p_curative(cs.stage, tier), 4), "tier": tier,
            "death_day": p.death if p.death < 10**6 else None, "death_ca_day": cs.death_ca,
            "gastrectomy": sv.get("gastrectomy"), "surgery_day": sv.get("surgery_day"), "regimen": sv.get("regimen"),
            "chemo_planned": sv.get("chemo_planned"), "chemo_done": sv.get("chemo_done"),
            "recurrence_day": sv.get("recurrence_day"),
            "original_dx_day": case["dx_day"], "original_stage": case["stage"], "original_status": case["status"],
            "original_death_day": case["death_day"], "original_treatment": case["treatment"],
            "original_p_curative": round(p_curative(case["stage"], tier), 4) if case["stage"] in STAGES else None,
            "stage_at_endo": cs.stage_at(int(endo_day)),
            "endoscopy_encounter_id": next((e[0] for e in rec.encs if e[1] == 5), None)})
        if supersede:
            upd["supersede_seq"] = adapter.supersede(int(person_id), int(endo_day), reason)
    return b.frames(), upd


def split(rows: dict[str, pl.DataFrame], t1: dt.datetime) -> tuple[dict, dict]:
    """(rows dated <= t1, rows dated after t1) with tick-window semantics (care.emr.window)."""
    from care import emr
    lo = dt.datetime(1970, 1, 1)
    return emr.window(rows, lo, t1), emr.window(rows, t1, FAR)


def commit(rows: dict[str, pl.DataFrame], upd: dict, t1: dt.datetime, adapter=None, tick: str = "") -> dict:
    """Write the part dated <= t1 now, defer the rest (replayed by the sim clock when due), log the intervention.
    Returns {"written": counts, "deferred": counts}."""
    from care import emr
    adapter = adapter or emr.get_adapter()
    now, later = split(rows, t1)
    written = adapter.write(now, tick or f"intervention:{upd['patient_id']}")
    deferred = adapter.defer(later, int(upd.get("supersede_seq") or 0), tick) if any(
        df.height for df in later.values()) else {}
    log_update(upd, adapter)
    return {"written": written, "deferred": deferred}


INTERVENTION_SCHEMA = {"patient_id": pl.Int64, "latent_person_id": pl.Int64, "endo_day": pl.Int32,
                       "site_location_id": pl.Int32, "seed": pl.Int64, "resimulated": pl.Boolean,
                       "supersede_seq": pl.Int64, "had_latent_cancer": pl.Boolean, "cancer_found": pl.Boolean,
                       "finding": pl.String, "status": pl.String, "stage": pl.String, "dx_day": pl.Int32,
                       "treatment": pl.String, "intent": pl.Int32, "p_curative": pl.Float64, "death_day": pl.Int32,
                       "original_dx_day": pl.Int32, "original_stage": pl.String, "original_death_day": pl.Int32,
                       "original_p_curative": pl.Float64, "stage_at_endo": pl.String,
                       "endoscopy_encounter_id": pl.Int64, "recorded_sim_time": pl.Datetime("us")}


def log_update(upd: dict, adapter) -> None:
    """Append to writeback/interventions.parquet (latent truth of re-simulated courses; never served to roles)."""
    import os
    row = {k: upd.get(k) for k in INTERVENTION_SCHEMA}
    row["recorded_sim_time"] = adapter.sim_time()
    df = pl.DataFrame([row], schema=INTERVENTION_SCHEMA)
    with adapter.locked():
        f = adapter.root / "interventions.parquet"
        cur = pl.read_parquet(f) if f.exists() else pl.DataFrame(schema=INTERVENTION_SCHEMA)
        tmp = adapter.root / "interventions.parquet.tmp"
        pl.concat([cur, df], how="vertical_relaxed").write_parquet(tmp)
        os.replace(tmp, f)


def interventions(adapter=None) -> pl.DataFrame:
    from care import emr
    adapter = adapter or emr.get_adapter()
    f = adapter.root / "interventions.parquet"
    return pl.read_parquet(f) if f.exists() else pl.DataFrame(schema=INTERVENTION_SCHEMA)


__all__ = ["resimulate_from_endoscopy", "commit", "split", "interventions", "latent_case", "latent_person",
           "latent_person_id", "rebuild_patient", "rebuild_case"]
