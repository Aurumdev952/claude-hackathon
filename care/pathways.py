"""Pathway templates (config/care_pathways.yaml) and the schedule math the engine uses."""
from __future__ import annotations

import datetime as dt
from functools import lru_cache

import yaml

from shared.config import CONFIG_DIR

TASK_TYPES = ("ENDOSCOPY", "PATHOLOGY_REVIEW", "RESULT_DISCUSSED", "HP_TEST", "HP_TREATMENT", "HP_TEST_OF_CURE",
              "HB_RECHECK", "IRON_COURSE", "ONCOLOGY_INTAKE", "STAGING_CT", "MDT_PLAN", "SURGERY", "CHEMO_CYCLE",
              "FOLLOWUP_VISIT", "B12_CHECK", "B12_INJECTION", "NUTRITION_REVIEW", "SURVEILLANCE_IMAGING", "PAIN_REVIEW",
              "CHW_VISIT")
CHANNELS = ("APP", "SMS", "CHW")
# alert trigger -> recommended pathway (pre-selected in the doctor's approval modal)
TRIGGER_PATHWAY = {"RISK_BAND_HIGH": "ENDOSCOPY_REFERRAL", "ALARM_NO_SCOPE_90D": "ENDOSCOPY_REFERRAL",
                   "HB_DROP": "ANAEMIA_WORKUP", "HP_POS_UNTREATED": "HP_TEST_AND_TREAT", "CARE_OVERDUE": None}


@lru_cache(maxsize=1)
def config() -> dict:
    with open(CONFIG_DIR / "care_pathways.yaml") as f:
        cfg = yaml.safe_load(f)
    for pid, p in cfg["pathways"].items():
        p["id"] = pid
        for t in p["tasks"]:
            assert t["type"] in TASK_TYPES, f"{pid}: unknown task type {t['type']}"
    return cfg


def pathways() -> dict[str, dict]:
    return config()["pathways"]


def pathway(pid: str) -> dict:
    p = pathways().get(pid)
    if p is None:
        raise KeyError(pid)
    return p


def ladder() -> list[dict]:
    return sorted(config()["ladder"], key=lambda s: s["offset_days"])


def task_spec(pid: str, ttype: str) -> dict:
    for t in pathway(pid)["tasks"]:
        if t["type"] == ttype:
            return t
    extra = config().get("extra_tasks", {}).get(ttype)
    if extra:
        return {"type": ttype, "opens_days": 0, "due_days": 7, **extra}
    raise KeyError(f"{pid}.{ttype}")


def patient_facing(pid: str, ttype: str) -> bool:
    try:
        return bool(task_spec(pid, ttype).get("patient_facing", True))
    except KeyError:
        return True


def occurrences(spec: dict) -> list[int]:
    """Due-day offsets (from the plan start) of a recurring task, e.g. every 91 d to day 1095 then every 182 d."""
    out: set[int] = set()
    for seg in spec.get("repeat") or []:
        d = int(seg["from_days"])
        while d <= int(seg["to_days"]):
            out.add(d)
            d += int(seg["every_days"])
    return sorted(out)


def window(spec: dict, occurrence_due: int) -> tuple[int, int]:
    """(opens, due) day offsets for one occurrence of a recurring task."""
    return max(0, occurrence_due - int(spec.get("window_days", 14))), occurrence_due


def applies(spec: dict, facts: dict) -> bool:
    cond = spec.get("when")
    return not cond or bool(facts.get(cond))


def start_tasks(pid: str, *, trigger: str | None = None, facts: dict | None = None) -> list[dict]:
    """Task specs created at approval, with (opens, due) offsets relative to the approval day."""
    p = pathway(pid)
    facts = facts or {}
    first = (p.get("start_by_trigger") or {}).get(trigger) if trigger else None
    out = []
    for t in p["tasks"]:
        if first:
            if t["type"] != first:
                continue
        elif not t.get("start") or not applies(t, facts):
            continue
        if t.get("repeat"):
            occ = occurrences(t)
            if not occ:
                continue
            o, d = window(t, occ[0])
            out.append({**t, "opens": o, "due": d, "occurrence": 0})
        else:
            due = int(t.get("due_days_alarm", t["due_days"])) if facts.get("alarm") else int(t["due_days"])
            out.append({**t, "opens": int(t.get("opens_days", 0)), "due": due, "occurrence": None})
        if first:
            break
    return out


def next_tasks(pid: str, ttype: str, result: str | None) -> list[str]:
    spec = task_spec(pid, ttype)
    nxt = spec.get("next") or {}
    if result and result in nxt:
        return list(nxt[result] or [])
    return list(nxt.get("*") or [])


def add_days(t: str | dt.datetime, days: float) -> dt.datetime:
    from .store import to_dt
    return to_dt(t) + dt.timedelta(days=days)


def public(pid: str) -> dict:
    """Shape for GET /care/pathways."""
    p = pathway(pid)
    tasks = []
    for t in p["tasks"]:
        due = occurrences(t)[0] if t.get("repeat") else t.get("due_days")
        tasks.append({"type": t["type"], "title": t["title"], "due_days": due,
                      "repeat": t.get("repeat"), "start": bool(t.get("start")), "when": t.get("when"),
                      "patient_facing": bool(t.get("patient_facing", True))})
    return {"id": pid, "name": p["name"], "description": p["description"], "triggers": p.get("triggers", []),
            "tasks": tasks, "default_channels": p.get("default_channels", ["APP", "SMS"]),
            "end_days": p.get("end_days")}
