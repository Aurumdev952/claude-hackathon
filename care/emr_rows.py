"""EMRBuilder: OpenMRS-style rows for care write-back (docs/contracts/v3-loop.md §2).

It is the generator's `Recorder` (generator/emit.py) with ids drawn from the care range (`care.emr.next_ids`,
CARE_ID_BASE + counter) and a `frames()` that returns Polars frames with exactly the bulk Parquet columns and dtypes
(`generator/writers.py:COLUMNS` / `SCHEMAS`). Rows get `creator=2` (care engine), a deterministic `uuid`, and
`date_created = max(sim time, event time)`.

Usage (care engine, care world)::

    from care.emr_rows import EMRBuilder
    from shared.concepts import C

    b = EMRBuilder(sim_time)                                   # sim_time: datetime (default: current sim time)
    e = b.encounter(patient_id, sim_time, 15, facility_id)     # 15 CARE_COORDINATION (or "CARE_COORDINATION")
    b.coded(e, C.CARE_PATHWAY, C.PW_ENDOSCOPY)
    b.text(e, C.CARE_TASK, "ENDOSCOPY")
    b.coded(e, C.NOTIFIED, C.CH_SMS)
    o = b.order(e, C.ORD_ENDOSCOPY, urgency="ROUTINE")         # order_type 2 (test); 3 = referral
    b.drug(e, C.CYANOCOBALAMIN, days=1)                        # orders + drug_order rows
    counts = b.write("care:plan CP-1234abcd")                  # = care.emr.get_adapter().write(b.frames(), tick)

- `encounter(patient_id, when, type_id, location_id, *, visit_id=None, visit_type=1)` -> encounter_id. `when` is a
  datetime, a date, or an int day (days since 1970-01-01; recorded at 10:00). Each encounter opens its own visit unless
  `visit_id` is given (`b.visit(...)` creates one explicitly).
- `obs(enc, concept, *, coded=None, num=None, text=None, group=None, order=None, at=None)` -> obs_id; shortcuts
  `coded(enc, concept, answer)`, `num(enc, concept, value, nd=1)`, `text(enc, concept, text)`, `group(enc, set_concept)`
  (an obs-group parent, pass its id as `group=` to children) and `dx(enc, dx_concept, confirmed=True)`.
  Obs take the patient, time and location of their encounter (`at` overrides the time).
- `order(enc, concept, order_type=2, urgency="ROUTINE", stopped=None)` -> order_id.
- `drug(enc, drug_concept, days, dose=1.0, freq="OD", qty=None)` -> order_id (also writes drug_order).
- `frames() -> dict[table, polars.DataFrame]` for visit, encounter, obs, orders, drug_order, patient_program.
- `recorder` is a `generator.emit.Recorder` view of the same rows: generator code (`_diagnose`, `_oncology`,
  `_survival`) can record straight into the builder (used by generator/intervention.py).

Ids are reserved in small blocks per table (unused ids are skipped, which OpenMRS allows). Pass `ids=callable(table,
n) -> list[int]` to use another allocator (tests use a counter, no files).
"""
from __future__ import annotations

import datetime as dt
from collections import deque
from typing import Callable

import polars as pl

from generator.emit import ENC, ORDER_DRUG, ORDER_TEST, Recorder
from generator.writers import SCHEMAS

from . import emr

MIN_PER_DAY = 1440
EPOCH = dt.datetime(1970, 1, 1)
ENC_NAME = {v: k for k, v in ENC.items()}
BLOCK = {"visit": 8, "encounter": 8, "obs": 64, "orders": 8, "patient_program": 2}


def to_minutes(when) -> int:
    """Epoch minutes for a datetime, a date (10:00) or an int day (10:00)."""
    if isinstance(when, dt.datetime):
        return int((when.replace(tzinfo=None) - EPOCH).total_seconds() // 60)
    if isinstance(when, dt.date):
        return (when - EPOCH.date()).days * MIN_PER_DAY + 600
    return int(when) * MIN_PER_DAY + 600


def from_minutes(t: int) -> dt.datetime:
    return EPOCH + dt.timedelta(minutes=int(t))


class _Ids:
    def __init__(self, alloc: Callable[[str, int], list[int]], block: dict | None = None):
        self.alloc, self.block = alloc, {**BLOCK, **(block or {})}
        self.pool: dict[str, deque] = {}

    def peek(self, table: str) -> int:
        q = self.pool.setdefault(table, deque())
        if not q:
            q.extend(self.alloc(table, self.block.get(table, 8)))
        return q[0]

    def advance(self, table: str):
        self.peek(table)
        self.pool[table].popleft()


def _counter_prop(table: str):
    return property(lambda s: s._ids.peek(table), lambda s, _v: s._ids.advance(table))


class CareRecorder(Recorder):
    """A Recorder whose id counters come from the care id range; every event is recordable (no go-live gate)."""
    next_visit = _counter_prop("visit")
    next_enc = _counter_prop("encounter")
    next_obs = _counter_prop("obs")
    next_order = _counter_prop("orders")

    def __init__(self, ids: _Ids, go_live: dict | None = None):  # noqa: D107 - Recorder.__init__ would set the counters
        self._ids = ids
        self.go_live_min = {k: v * MIN_PER_DAY for k, v in (go_live or {}).items()}
        self.visits, self.encs, self.obs_rows, self.orders, self.drug_orders, self.programs = [], [], [], [], [], []
        self.first_enc = {}
        self.emr_start_min = 0
        self.pid = 0
        self._marks = (0, 0, 0, 0, 0, 0)


class EMRBuilder:
    def __init__(self, sim_time: dt.datetime | None = None, *, ids: Callable[[str, int], list[int]] | None = None,
                 adapter=None, block: dict | None = None):
        self.adapter = adapter
        self.sim_time = sim_time or (adapter.sim_time() if adapter else emr.current_sim_time())
        alloc = ids or (adapter.next_ids if adapter else emr.next_ids)
        self.recorder = CareRecorder(_Ids(alloc, block))
        self._enc: dict[int, tuple[int, int, int]] = {}  # encounter_id -> (patient_id, t, location_id)

    # ------------------------------------------------------------------ structure
    def _set_patient(self, pid: int):
        self.recorder.pid = int(pid)

    def visit(self, patient_id: int, when, location_id: int, visit_type: int = 1, hours: float = 1.0) -> int:
        self._set_patient(patient_id)
        return self.recorder.visit(to_minutes(when), int(location_id), visit_type, hours)

    def encounter(self, patient_id: int, when, type_id: int | str, location_id: int, *, visit_id: int | None = None,
                  visit_type: int = 1) -> int:
        etype = type_id if isinstance(type_id, str) else ENC_NAME[int(type_id)]
        t = to_minutes(when)
        self._set_patient(patient_id)
        if visit_id is None:
            visit_id = self.recorder.visit(t, int(location_id), visit_type, hours=1.0)
        eid = self.recorder.encounter(t, etype, int(location_id), visit_id=visit_id)
        self._enc[eid] = (int(patient_id), t, int(location_id))
        return eid

    def _ctx(self, enc: int, at=None):
        pid, t, loc = self._enc[enc]
        self._set_patient(pid)
        return (to_minutes(at) if at is not None else t), loc

    # ------------------------------------------------------------------ facts
    def obs(self, enc: int, concept: int, *, coded=None, num=None, text=None, group=None, order=None, at=None) -> int:
        t, loc = self._ctx(enc, at)
        return self.recorder.obs(enc, t, loc, int(concept), coded=coded, num=None if num is None else float(num),
                                 text=text, group=group, order=order)

    def coded(self, enc: int, concept: int, answer: int, group=None, at=None) -> int:
        return self.obs(enc, concept, coded=int(answer), group=group, at=at)

    def num(self, enc: int, concept: int, value: float, nd: int = 1, group=None, at=None) -> int:
        return self.obs(enc, concept, num=round(float(value), nd), group=group, at=at)

    def text(self, enc: int, concept: int, text: str, group=None, at=None) -> int:
        return self.obs(enc, concept, text=str(text), group=group, at=at)

    def group(self, enc: int, set_concept: int, at=None) -> int:
        return self.obs(enc, set_concept, at=at)

    def dx(self, enc: int, dx_concept: int, confirmed: bool = True, primary: bool = True, at=None) -> int:
        t, loc = self._ctx(enc, at)
        return self.recorder.dx(enc, t, loc, dx_concept, confirmed=confirmed, primary=primary)

    def order(self, enc: int, concept: int, order_type: int = ORDER_TEST, urgency: str = "ROUTINE", stopped=None,
              at=None) -> int:
        t, _ = self._ctx(enc, at)
        return self.recorder.order(enc, t, int(concept), order_type, urgency,
                                   None if stopped is None else to_minutes(stopped))

    def drug(self, enc: int, drug_concept: int, days: int, dose: float = 1.0, freq: str = "OD", qty: float | None = None,
             at=None) -> int:
        t, _ = self._ctx(enc, at)
        return self.recorder.drug(enc, t, int(drug_concept), int(days), dose, freq, qty)

    def program(self, patient_id: int, program_id: int, when, location_id: int, completed=None):
        self._set_patient(patient_id)
        self.recorder.program(program_id, to_minutes(when), int(location_id),
                              None if completed is None else to_minutes(completed))

    # ------------------------------------------------------------------ output
    def frames(self) -> dict[str, pl.DataFrame]:
        return recorder_frames(self.recorder, self.sim_time, self.recorder._ids.alloc)

    def write(self, tick: str = "") -> dict[str, int]:
        ad = self.adapter or emr.get_adapter()
        return ad.write(self.frames(), tick)

    def __len__(self):
        return len(self.recorder.encs)


def _dtcol(name: str) -> pl.Expr:
    return pl.from_epoch(pl.col(name).cast(pl.Int64) * 60, time_unit="s").cast(pl.Datetime("us")).alias(name)


def recorder_frames(rec: Recorder, sim_time: dt.datetime, alloc: Callable[[str, int], list[int]] | None = None,
                    created_offset_min: int = 0) -> dict[str, pl.DataFrame]:
    """Recorder tuples -> conformed frames (bulk dtypes). date_created = max(sim time, event time + offset)."""
    def created(col: str) -> pl.Expr:  # epoch-minute event column -> datetime, never before the sim time
        ev = pl.from_epoch(pl.col(col).cast(pl.Int64) * 60 + created_offset_min * 60, time_unit="s").cast(pl.Datetime("us"))
        return pl.max_horizontal(ev, pl.lit(sim_time.replace(tzinfo=None), pl.Datetime("us")))

    out: dict[str, pl.DataFrame] = {}
    v = pl.DataFrame(rec.visits, schema=["visit_id", "patient_id", "visit_type_id", "date_started", "date_stopped",
                                         "location_id"], orient="row")
    out["visit"] = v.with_columns(created("date_started").alias("date_created"))
    e = pl.DataFrame(rec.encs, schema=["encounter_id", "encounter_type", "patient_id", "location_id", "visit_id",
                                       "encounter_datetime"], orient="row")
    out["encounter"] = e.with_columns(created("encounter_datetime").alias("date_created"))
    o = pl.DataFrame(rec.obs_rows, schema={"obs_id": pl.Int64, "person_id": pl.Int64, "concept_id": pl.Int32,
                                           "encounter_id": pl.Int64, "order_id": pl.Int64, "obs_datetime": pl.Int64,
                                           "location_id": pl.Int32, "obs_group_id": pl.Int64, "value_coded": pl.Int32,
                                           "value_numeric": pl.Float64, "value_text": pl.String}, orient="row")
    out["obs"] = o.with_columns(created("obs_datetime").alias("date_created"))
    r = pl.DataFrame(rec.orders, schema=["order_id", "order_type_id", "concept_id", "patient_id", "encounter_id",
                                         "date_activated", "date_stopped", "urgency"], orient="row")
    out["orders"] = r.with_columns(created("date_activated").alias("date_created"))
    out["drug_order"] = pl.DataFrame(rec.drug_orders, schema={
        "order_id": pl.Int64, "drug_inventory_id": pl.Int32, "dose": pl.Float64, "dose_units": pl.Int32,
        "frequency": pl.String, "duration": pl.Int32, "duration_units": pl.String, "quantity": pl.Float64,
        "num_refills": pl.Int32}, orient="row")
    pg = pl.DataFrame(rec.programs, schema={"patient_id": pl.Int64, "program_id": pl.Int16, "date_enrolled": pl.Int64,
                                            "date_completed": pl.Int64, "location_id": pl.Int32}, orient="row")
    if pg.height:
        if alloc is None:
            raise ValueError("patient_program rows need an id allocator")
        pg = pg.with_columns(pl.Series("patient_program_id", alloc("patient_program", pg.height), pl.Int64))
    else:
        pg = pg.with_columns(pl.lit(None, pl.Int64).alias("patient_program_id"))
    out["patient_program"] = pg.with_columns(created("date_enrolled").alias("date_created"))
    time_cols = ("date_started", "date_stopped", "encounter_datetime", "obs_datetime", "date_activated",
                 "date_enrolled", "date_completed")
    res = {}
    for t, df in out.items():
        df = df.with_columns([_dtcol(c) for c in time_cols if c in df.columns])
        res[t] = emr.conform(t, df, sim_time)
    return res


__all__ = ["EMRBuilder", "CareRecorder", "recorder_frames", "to_minutes", "from_minutes", "ORDER_DRUG", "ORDER_TEST",
           "SCHEMAS"]
