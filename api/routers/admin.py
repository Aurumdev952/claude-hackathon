"""Demo controls for the simulator (SPEC §10.1, §14.2 POST /admin/sim). The API only writes a control file; the
simulator process reads it every loop."""
from __future__ import annotations

import datetime as dt
import json
import os

from fastapi import APIRouter, Body

from shared.config import SIM_STATE_DIR

from ..deps import APIError, envelope

router = APIRouter()
CONTROL = SIM_STATE_DIR / "control.json"


def read_control() -> dict:
    try:
        return json.load(open(CONTROL))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"paused": False, "demo_mode": False, "fast_forward_days": 0}


@router.post("/admin/sim")
def sim(body: dict = Body(...)):
    action = body.get("action")
    c = read_control()
    if action == "pause":
        c["paused"] = True
    elif action == "resume":
        c["paused"] = False
    elif action == "demo_mode":
        c["demo_mode"] = bool(body.get("enabled", True))
    elif action == "fast_forward":
        days = int(body.get("days", 7))
        if not 1 <= days <= 365:
            raise APIError(400, "INVALID_DAYS", "days must be 1-365")
        c["fast_forward_days"] = int(c.get("fast_forward_days", 0)) + days
    else:
        raise APIError(400, "INVALID_ACTION", "action must be pause|resume|demo_mode|fast_forward")
    c["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    SIM_STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONTROL.with_suffix(".tmp")
    json.dump(c, open(tmp, "w"))
    os.replace(tmp, CONTROL)
    return envelope(c)
