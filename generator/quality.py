"""Realistic data-quality noise (SPEC §8.9). Applied to chunk rows before writing; every injected issue is
logged so the pipeline's detection can be tested against ground truth."""
from __future__ import annotations

import random

from shared.concepts import C

from .context import HIST_END, MIN_PER_DAY
from .life import openmrs_id

LAB_NUMERIC = {C.HB, C.MCV, C.FERRITIN, C.WBC, C.PLT, C.ALT, C.AST, C.ALB, C.CEA, C.CREAT, C.RBG, C.HBA1C}


def apply_noise(out: dict, cfg: dict, facs: list[dict], seed: int) -> dict:
    q = cfg["quality_noise"]
    rnd = random.Random(seed * 31 + 5)
    rec = out["rec"]
    log = {"voided": 0, "amended": 0, "hb_gL": 0, "future_dated": 0, "before_birth": 0, "duplicates": [],
           "birthdate_estimated": 0}
    gl_facs = {f["location_id"] for f in facs if f.get("hb_gL")}
    hist_end_min = (HIST_END + 1) * MIN_PER_DAY

    # obs-level noise: (oid, pid, concept, enc, order, t, loc, group, coded, num, text) -> + status, voided, date_created
    new_obs = []
    extra = []
    next_extra = max((o[0] for o in rec["obs"]), default=0) + 1
    for o in rec["obs"]:
        oid, pid, concept, enc, order, t, loc, group, coded, num, text = o
        status, voided, created = "FINAL", 0, t + rnd.randint(0, 25)
        if concept == C.HB and loc in gl_facs and num is not None and rnd.random() < 0.45:
            num = round(num * 10, 0)
            log["hb_gL"] += 1
        if concept in LAB_NUMERIC and num is not None and t < hist_end_min and rnd.random() < q["amended_labs"]:
            wrong = round(num * rnd.choice([0.7, 1.3, 1.5]), 1)
            new_obs.append((oid, pid, concept, enc, order, t, loc, group, coded, wrong, text, "FINAL", 0, created))
            amended_created = created + rnd.randint(1, 3) * MIN_PER_DAY
            extra.append((next_extra, pid, concept, enc, order, t, loc, group, coded, num, text, "AMENDED", 0, amended_created))
            next_extra += 1
            log["amended"] += 1
            continue
        if rnd.random() < q["voided_obs"]:
            voided = 1
            log["voided"] += 1
        new_obs.append((oid, pid, concept, enc, order, t, loc, group, coded, num, text, status, voided, created))
    rec["obs"] = new_obs + extra

    # encounter dating errors (bulk only): future-dated or before birth
    births = {p[0]: p[2] for p in out["persons"]["person"]}
    encs = []
    for e in rec["encs"]:
        eid, et, pid, loc, vid, t = e
        if t < hist_end_min and rnd.random() < q.get("future_dated", 0.0005):
            if rnd.random() < 0.6:
                t = t + rnd.randint(3, 6) * 365 * MIN_PER_DAY
                log["future_dated"] += 1
                encs.append((eid, et, pid, loc, vid, t, 1))  # flag: keep in bulk even though date looks future
                continue
            t = (births.get(pid, 0) - rnd.randint(30, 400)) * MIN_PER_DAY
            log["before_birth"] += 1
            encs.append((eid, et, pid, loc, vid, t, 1))
            continue
        encs.append((eid, et, pid, loc, vid, t, 0))
    rec["encs"] = encs

    # estimated birthdates (heaping on Jan 1 / Jul 1)
    import datetime as dt
    persons = []
    for row in out["persons"]["person"]:
        pid, sex, birth, est, dead, dday, cod, t0 = row
        y = (dt.date(1970, 1, 1) + dt.timedelta(days=birth)).year
        # estimated birthdates are an adult phenomenon (rate rescaled so ~20% of all persons are estimated)
        if y < 2005 and rnd.random() < q["birthdate_estimated"] * 1.35:
            birth = (dt.date(y, 1 if rnd.random() < 0.6 else 7, 1) - dt.date(1970, 1, 1)).days
            est = 1
            log["birthdate_estimated"] += 1
        persons.append((pid, sex, birth, est, dead, dday, cod, t0))
    out["persons"]["person"] = persons
    _duplicates(out, q["duplicate_patients"], rnd, log)
    out["noise_log"] = log
    return out


def _variant(name: str, rnd: random.Random) -> str:
    if len(name) < 4:
        return name + "e"
    i = rnd.randint(1, len(name) - 2)
    ops = [lambda s: s[:i] + s[i + 1:], lambda s: s[:i] + s[i] + s[i:], lambda s: s[:i] + {"a": "e", "e": "a", "i": "y", "y": "i", "o": "u", "u": "o"}.get(s[i], s[i]) + s[i + 1:]]
    v = rnd.choice(ops)(name)
    return v if v != name else name[:-1] + ("a" if name[-1] != "a" else "e")


def _duplicates(out: dict, rate: float, rnd: random.Random, log: dict):
    """Clone ~rate of patients into a second record (spelling variant, same birthdate/district) and move part of
    their history (whole visits) to the duplicate id."""
    rec = out["rec"]
    pers = out["persons"]
    chunk = out["chunk"]
    n_enc = {}
    for e in rec["encs"]:
        n_enc[e[2]] = n_enc.get(e[2], 0) + 1
    cands = [p for p, n in n_enc.items() if n >= 4]
    k = int(round(len(n_enc) * rate))
    picked = rnd.sample(cands, min(k, len(cands)))
    if not picked:
        return
    dup_of = {pid: 900_000_000 + chunk * 100_000 + j for j, pid in enumerate(picked)}
    # choose visits to move
    visits_by_pid: dict[int, list[int]] = {}
    for v in rec["visits"]:
        if v[1] in dup_of:
            visits_by_pid.setdefault(v[1], []).append(v[0])
    move_visits = set()
    for pid, vs in visits_by_pid.items():
        vs = sorted(vs)
        cut = rnd.randint(max(1, len(vs) // 3), max(1, (2 * len(vs)) // 3))
        move_visits.update(vs[cut:] if rnd.random() < 0.5 else vs[:cut])
    moved_enc = {e[0] for e in rec["encs"] if e[4] in move_visits}
    rec["visits"] = [(v[0], dup_of[v[1]], *v[2:]) if v[0] in move_visits else v for v in rec["visits"]]
    rec["encs"] = [(e[0], e[1], dup_of[e[2]], *e[3:]) if e[0] in moved_enc else e for e in rec["encs"]]
    rec["obs"] = [(o[0], dup_of[o[1]], *o[2:]) if o[3] in moved_enc else o for o in rec["obs"]]
    rec["orders"] = [(o[0], o[1], o[2], dup_of[o[3]], *o[4:]) if o[4] in moved_enc else o for o in rec["orders"]]
    first, first_any = {}, {}
    for e in rec["encs"]:
        first_any[e[2]] = min(first_any.get(e[2], 10**12), e[5])
        if not e[6]:  # mis-dated noise encounters (future / before birth) must not set the record's creation date
            first[e[2]] = min(first.get(e[2], 10**12), e[5])
    for o in rec["obs"]:  # obs keep their true time, so they bound the creation date when every encounter is mis-dated
        if o[1] >= 900_000_000:
            first[o[1]] = min(first.get(o[1], first_any.get(o[1], 10**12)), o[5])
    first = {**first_any, **first}
    by_pid = {r[0]: r for r in pers["person"]}
    names = {r[0]: r for r in pers["person_name"]}
    addrs = [r for r in pers["person_address"] if r[0] in dup_of]
    for pid, did in dup_of.items():
        if did not in first:
            continue
        t0 = first[did]
        pr = by_pid[pid]
        pers["person"].append((did, pr[1], pr[2], pr[3], 0, None, None, t0))
        nm = names[pid]
        pers["person_name"].append((did, _variant(nm[1], rnd), nm[2] if rnd.random() < 0.7 else _variant(nm[2], rnd), t0))
        a = next(r for r in addrs if r[0] == pid)
        pers["person_address"].append((did, 1, a[2], a[3], a[4], a[5], a[6], t0, None, t0))
        phone = next((r for r in pers["person_attribute"] if r[0] == pid and r[2] == 1), None)
        if phone and rnd.random() < 0.5:
            pers["person_attribute"].append((did, phone[1], 1, t0))
        pers["patient"].append((did, t0))
        ident = next(r for r in pers["patient_identifier"] if r[0] == pid and r[2] == 1)
        seq = 8_000_000 + chunk * 1000 + list(dup_of).index(pid)
        pers["patient_identifier"].append((did, openmrs_id(ident[1].split("-")[0], seq), 1, 1, ident[4], t0))
        log["duplicates"].append([pid, did])
