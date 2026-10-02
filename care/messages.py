"""Message catalogue (care/messages.yaml): render patient / CHW notification text. English only.

Bodies never carry a name: the patient app shows `greeting` (with the first name) on screen only (contract §4.1).
"""
from __future__ import annotations

import datetime as dt
import re
from functools import lru_cache
from pathlib import Path

import yaml

PATH = Path(__file__).with_name("messages.yaml")
STAGES = ("approved", "reminder", "due", "overdue", "completed")
FORBIDDEN = ("cancer", "malignant", "tumour", "tumor", "carcinoma", "oncology", "biopsy result")


@lru_cache(maxsize=1)
def catalogue() -> dict:
    with open(PATH) as f:
        return yaml.safe_load(f)


def resolve(pathway: str, task: str, stage: str) -> tuple[str, dict]:
    """Most specific entry: <pathway>.<task>.<stage> -> default.<task>.<stage> -> default.default.<stage>.

    Missing task stages fall back to the generic stage text (not the task's other stages)."""
    cat = catalogue()
    for scope, t in ((pathway, task), ("default", task), ("default", "default")):
        e = ((cat.get(scope) or {}).get(t) or {}).get(stage)
        if e:
            return f"{scope}.{t}.{stage}", e
    raise KeyError(f"{pathway}.{task}.{stage}")


def fmt_date(v) -> str:
    if isinstance(v, str):
        v = dt.datetime.fromisoformat(v[:19])
    return f"{v.day} {v.strftime('%B %Y')}"


def render(pathway: str, task: str, stage: str, channel: str, *, task_title: str, facility: str, date,
           display_id: str | None = None, days: int | None = None) -> dict:
    """-> {template_key, title, body} for one channel. CHW messages address the CHW (display id only)."""
    vals = {"task": _task_phrase(task_title), "facility": facility or "your health centre",
            "date": fmt_date(date) if date else "soon", "days": days if days is not None else "",
            "display_id": display_id or ""}
    if channel == "CHW":
        st = "approved" if stage in ("approved", "reminder", "due") else "overdue"
        e = catalogue()["chw"][st]
        key = f"chw.{st}"
        return {"template_key": key, "title": e["title"], "body": e["body"].format(**vals)}
    key, e = resolve(pathway, task, stage)
    body = e["sms"] if channel == "SMS" else e["body"]
    return {"template_key": key, "title": e["title"], "body": body.format(**vals)}


def greeting(first_name: str | None) -> str:
    return catalogue()["greeting"].format(first_name=first_name or "there")


def _task_phrase(title: str) -> str:
    t = (title or "check-up").strip()
    return t[0].lower() + t[1:] if t[:1].isupper() and not t[:2].isupper() else t


def forbidden_hits(text: str) -> list[str]:
    low = text.lower()
    return [w for w in FORBIDDEN if re.search(r"\b" + re.escape(w) + r"\b", low)]
