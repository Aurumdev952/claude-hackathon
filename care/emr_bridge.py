"""The care engine's path into the EMR (docs/contracts/v3-loop.md §2).

`care.emr` (track L1) owns the adapter. This module only builds OpenMRS-shaped rows (visit, encounter, obs, orders) with
ids from `adapter.next_ids` and hands them to `adapter.write`. If `care.emr` is not importable (early in the parallel
build, or in unit tests) a `MemoryEMR` keeps the rows in memory so the engine still works end to end.
"""
from __future__ import annotations

import datetime as dt
import threading
import uuid as _uuid

import polars as pl

from shared.concepts import C

CARE_ID_BASE = 1_900_000_000
CREATOR = 2  # "care engine" system user
VISIT_TYPE_OPD = 1
ORDER_DRUG, ORDER_TEST, ORDER_REFERRAL = 1, 2, 3
ENC_CARE, ENC_PATIENT, ENC_CHW = 15, 16, 17


class MemoryEMR:
    """Fallback / test adapter with the contract interface. Rows stay in `self.rows[table]`."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {}
        self._next: dict[str, int] = {}
        self._lock = threading.Lock()
        self._superseded: list[dict] = []

    def next_ids(self, table: str, n: int) -> list[int]:
        with self._lock:
            start = self._next.get(table, CARE_ID_BASE + 1)
            self._next[table] = start + n
        return list(range(start, start + n))

    def write(self, rows: dict, tick: str | None = None) -> dict:
        out = {}
        with self._lock:
            for t, df in rows.items():
                recs = df.to_dicts() if hasattr(df, "to_dicts") else list(df)
                self.rows.setdefault(t, []).extend(recs)
                out[t] = len(recs)
        return out

    def supersede(self, patient_id: int, from_day: int, reason: str):
        self._superseded.append({"patient_id": patient_id, "from_day": from_day, "reason": reason})

    def superseded(self):
        return pl.DataFrame(self._superseded)


_ADAPTER = None
_LOCK = threading.Lock()


def adapter():
    global _ADAPTER
    with _LOCK:
        if _ADAPTER is None:
            try:
                from care import emr  # track L1
                _ADAPTER = emr.get_adapter()
            except ImportError:
                print("care: care.emr not available yet - EMR rows are kept in memory only")
                _ADAPTER = MemoryEMR()
        return _ADAPTER


def set_adapter(a):
    """Tests inject a fake adapter; returns the previous one."""
    global _ADAPTER
    with _LOCK:
        old, _ADAPTER = _ADAPTER, a
        return old


def _schemas() -> dict:
    from generator.writers import SCHEMAS
    return SCHEMAS


class Rows:
    """Build one patient's rows for one encounter, then `commit()` them through the adapter."""

    def __init__(self, patient_id: int, location_id: int, when: dt.datetime, enc_type: int, sim_time: dt.datetime,
                 emr=None):
        self.emr = emr or adapter()
        self.pid, self.loc, self.t, self.sim = int(patient_id), int(location_id), when, sim_time
        self.visit_id = self.emr.next_ids("visit", 1)[0]
        self.encounter_id = self.emr.next_ids("encounter", 1)[0]
        self.data: dict[str, list[dict]] = {"visit": [], "encounter": [], "obs": [], "orders": [], "drug_order": []}
        self.data["visit"].append({"visit_id": self.visit_id, "patient_id": self.pid, "visit_type_id": VISIT_TYPE_OPD,
                                   "date_started": when, "date_stopped": when + dt.timedelta(minutes=30),
                                   "location_id": self.loc, **self._meta()})
        self.data["encounter"].append({"encounter_id": self.encounter_id, "encounter_type": enc_type, "patient_id": self.pid,
                                       "location_id": self.loc, "visit_id": self.visit_id, "encounter_datetime": when,
                                       **self._meta()})

    def _meta(self) -> dict:
        return {"creator": CREATOR, "date_created": self.sim, "voided": 0, "uuid": str(_uuid.uuid4())}

    def obs(self, concept: int, *, coded: int | None = None, num: float | None = None, text: str | None = None,
            order_id: int | None = None) -> int:
        oid = self.emr.next_ids("obs", 1)[0]
        self.data["obs"].append({"obs_id": oid, "person_id": self.pid, "concept_id": int(concept),
                                 "encounter_id": self.encounter_id, "order_id": order_id, "obs_datetime": self.t,
                                 "location_id": self.loc, "obs_group_id": None, "value_coded": coded,
                                 "value_numeric": None if num is None else float(num), "value_text": text,
                                 "value_datetime": None, "comments": None, "status": "FINAL", "void_reason": None,
                                 **self._meta()})
        return oid

    def order(self, concept: int, otype: int | None = None, urgency: str = "ROUTINE",
              stopped: dt.datetime | None = None) -> int:
        if otype is None:
            otype = ORDER_REFERRAL if concept in (C.ORD_REF_HOSP, C.ORD_ONCOLOGY, C.ORD_FOLLOWUP, C.ORD_CHW) else ORDER_TEST
        oid = self.emr.next_ids("orders", 1)[0]
        self.data["orders"].append({"order_id": oid, "order_type_id": otype, "concept_id": int(concept), "patient_id": self.pid,
                                    "encounter_id": self.encounter_id, "date_activated": self.t, "date_stopped": stopped,
                                    "urgency": urgency, **self._meta()})
        return oid

    def frames(self) -> dict[str, pl.DataFrame]:
        sch = _schemas()
        out = {}
        for t, recs in self.data.items():
            if recs:
                cols = sch[t]
                out[t] = pl.DataFrame([{c: r.get(c) for c in cols} for r in recs], schema=cols, orient="row")
        return out

    def commit(self, tick: str | None = None) -> dict:
        return self.emr.write(self.frames(), tick or self.sim.strftime("%Y-%m-%dT%H:%M:%S"))
