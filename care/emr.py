"""EMR write-back adapter (docs/contracts/v3-loop.md §2).

New OpenMRS rows that appear after the bootstrap go through this module, whoever creates them:

- the sim clock (`simulator/local.py`) replays pre-simulated future rows (generator ids are kept);
- the care engine (L2) writes CARE_COORDINATION / PATIENT_REPORTED encounters built with `care.emr_rows.EMRBuilder`;
- the care world (`simulator/care_world.py`) writes outcomes (endoscopies, labs, CHW visits, chemo cycles) and, through
  `generator/intervention.py`, re-simulated trajectories that replace a patient's pre-simulated future.

Two backends, chosen by env `EMR_MODE=local|mysql` (default `local`):

- `ParquetEMR` (dev, cloud): Parquet parts under `data/bulk/writeback/` that `pipeline/extract.py:local_extract` ingests.
- `MySQLEMR` (full deployment): `INSERT IGNORE` into the OpenMRS tables (same pattern as `simulator/tick.py`). Written but
  not exercised in cloud sessions (no MySQL there).

Layout of `data/bulk/writeback/` (local mode)::

    <table>/part-<seq:06d>.parquet       rows, columns and dtypes exactly as generator/writers.py:COLUMNS / SCHEMAS
    sim_tick_log/part-<seq:06d>.parquet  (tick_id, sim_time, wall_time, encounters_added, obs_added)
    superseded.parquet                   (patient_id, from_day, reason, at_sim_time, seq)
    deferred/<table>/part-<seq>.parquet  re-simulated rows dated after the current tick, replayed by date later
                                         (extra column `_sup` = the supersede seq that created them)
    state.json                           {"seq", "ids": {table: last id}, "tick_seq"}
    manifest.jsonl                       one line per write (seq, tick, counts)
    .lock                                flock for every read-modify-write (API and simulator are separate processes)

Ids: replayed rows keep their generator ids; rows created here use `CARE_ID_BASE` (1,900,000,000) + a per-table counter
(`next_ids`). Ids stay below 2^31.

Supersede: `supersede(pid, from_day, reason)` records that a patient's pre-simulated future from `from_day` on (their
encounters, the obs/orders of those encounters, the drug orders of those orders, visits, programmes) must never be
replayed. Deferred rows written by an earlier re-simulation (`_sup` < the new seq) are superseded the same way.

Module-level shortcuts (`write`, `next_ids`, `supersede`, `superseded`) call `get_adapter()`.
"""
from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path

import polars as pl

from generator.writers import ALL_TABLES, COLUMNS, SCHEMAS

CARE_ID_BASE = 1_900_000_000
CARE_CREATOR = 2  # users.user_id 2 = "care engine" system user
ID_KEYS = {"person": "person_id", "person_name": "person_name_id", "person_address": "person_address_id",
           "person_attribute": "person_attribute_id", "patient": "patient_id",
           "patient_identifier": "patient_identifier_id", "visit": "visit_id", "encounter": "encounter_id",
           "obs": "obs_id", "orders": "order_id", "drug_order": "order_id", "patient_program": "patient_program_id"}
# tables that own an id sequence (drug_order shares order_id with orders; patient shares person_id)
ID_TABLES = ["person", "person_name", "person_address", "person_attribute", "patient_identifier", "visit", "encounter",
             "obs", "orders", "patient_program"]
TICK_SCHEMA = {"tick_id": pl.Int32, "sim_time": pl.Datetime("us"), "wall_time": pl.Datetime("us"),
               "encounters_added": pl.Int32, "obs_added": pl.Int32}
SUPERSEDED_SCHEMA = {"patient_id": pl.Int64, "from_day": pl.Int32, "reason": pl.String,
                     "at_sim_time": pl.Datetime("us"), "seq": pl.Int64}
SIM_START = dt.datetime(2026, 6, 30, 23, 59, 59)
_UUID_NS = uuid.UUID("6f1c2b1e-5d1a-4c6e-9a51-0e5a1c7e2b01")


class BusyError(RuntimeError):
    pass


# ----------------------------------------------------------------------------------------------- helpers
def _paths():
    from shared import config  # resolved at call time so tests can point DATA_DIR elsewhere before importing
    return config.BULK_DIR / "writeback", config.SIM_STATE_DIR


def current_sim_time(sim_state_dir: Path | None = None) -> dt.datetime:
    """The simulated "now" (`data/sim_state/sim_state.json`), 2026-06-30T23:59:59 before the first advance."""
    d = sim_state_dir or _paths()[1]
    try:
        return dt.datetime.fromisoformat(json.load(open(d / "sim_state.json"))["sim_time"])
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return SIM_START


def make_uuids(table: str, ids) -> list[str]:
    """Deterministic uuids (same table + id -> same uuid), so a re-run with the same seed gives identical rows."""
    return [str(uuid.uuid5(_UUID_NS, f"{table}:{int(i)}")) for i in ids]


def conform(table: str, df: pl.DataFrame, created: dt.datetime | None = None) -> pl.DataFrame:
    """Select COLUMNS[table] in order with the bulk dtypes. Missing columns: creator=2, voided=0, obs.status=FINAL,
    deterministic uuid, date_created=`created` (sim time), everything else null."""
    schema = SCHEMAS[table]
    created = created or current_sim_time()
    out = []
    for c, typ in schema.items():
        if c in df.columns:
            out.append(pl.col(c).cast(typ))
        elif c == "creator":
            out.append(pl.lit(CARE_CREATOR, typ).alias(c))
        elif c == "voided":
            out.append(pl.lit(0, typ).alias(c))
        elif c == "status" and table == "obs":
            out.append(pl.lit("FINAL", typ).alias(c))
        elif c == "date_created":
            out.append(pl.lit(created, typ).alias(c))
        elif c == "uuid":
            key = ID_KEYS[table]
            ids = df[key] if key in df.columns else range(df.height)
            out.append(pl.Series(c, make_uuids(table, ids), dtype=pl.String))
        else:
            out.append(pl.lit(None, typ).alias(c))
    return df.select(out) if df.height else pl.DataFrame(schema=schema)


def empty(table: str) -> pl.DataFrame:
    return pl.DataFrame(schema=SCHEMAS[table])


def window(frames: dict, t0: dt.datetime, t1: dt.datetime) -> dict[str, pl.DataFrame]:
    """Rows of `frames` (table -> DataFrame/LazyFrame) that happen in (t0, t1], with the same rules as
    simulator/tick.py:window_rows: encounters by datetime; obs/orders through their encounter; drug orders through their
    order; visits/person/address/programme by their own date; person-level rows of persons created in the window."""
    def lf(n):
        f = frames.get(n)
        if f is None:
            return pl.LazyFrame(schema=SCHEMAS[n])
        return f.lazy() if isinstance(f, pl.DataFrame) else f

    def inw(c):
        return (pl.col(c) > t0) & (pl.col(c) <= t1)
    enc = lf("encounter").filter(inw("encounter_datetime")).collect()
    eids = enc["encounter_id"].implode()
    out = {"encounter": enc,
           "person": lf("person").filter(inw("date_created")).collect(),
           "person_address": lf("person_address").filter(inw("start_date")).collect(),
           "visit": lf("visit").filter(inw("date_started")).collect(),
           "obs": lf("obs").filter(pl.col("encounter_id").is_in(eids)).collect().sort("obs_id"),
           "orders": lf("orders").filter(pl.col("encounter_id").is_in(eids)).collect(),
           "patient_program": lf("patient_program").filter(inw("date_enrolled")).collect()}
    pids = out["person"]["person_id"].implode()
    for n, key in (("person_name", "person_id"), ("person_attribute", "person_id"), ("patient", "patient_id"),
                   ("patient_identifier", "patient_id")):
        out[n] = lf(n).filter(pl.col(key).is_in(pids)).collect()
    out["drug_order"] = lf("drug_order").filter(pl.col("order_id").is_in(out["orders"]["order_id"].implode())).collect()
    return out


def drop_superseded(rows: dict[str, pl.DataFrame], sup: pl.DataFrame, row_sup: int | str = 0) -> dict[str, pl.DataFrame]:
    """Remove rows a supersede record covers: the patient's encounters/visits/programmes dated on or after from_day,
    plus the obs and orders of those encounters and the drug orders of those orders.

    `row_sup` is the supersede seq that created the rows (0 = original generator future); a supersede record only
    applies to rows created before it. Pass a column name (e.g. "_sup") for rows carrying their own seq."""
    if sup is None or sup.height == 0:
        return rows
    sup = sup.select("patient_id", (pl.col("from_day").cast(pl.Int64) * 86_400_000_000).cast(pl.Datetime("us"))
                     .alias("_from"), pl.col("seq").alias("_sseq"))

    rs = pl.col(row_sup) if isinstance(row_sup, str) else pl.lit(row_sup)

    def covered(df, pid_col, tcol, key) -> pl.Series:
        return (df.join(sup, left_on=pid_col, right_on="patient_id", how="inner")
                .filter((pl.col(tcol) >= pl.col("_from")) & (pl.col("_sseq") > rs))[key].unique())

    out = dict(rows)
    drop_enc = pl.Series("encounter_id", [], pl.Int64)
    enc = rows.get("encounter")
    if enc is not None and enc.height:
        drop_enc = covered(enc, "patient_id", "encounter_datetime", "encounter_id")
        out["encounter"] = enc.filter(~pl.col("encounter_id").is_in(drop_enc.implode()))
    for n, tcol, key in (("visit", "date_started", "visit_id"), ("patient_program", "date_enrolled", "patient_program_id")):
        df = rows.get(n)
        if df is not None and df.height:
            out[n] = df.filter(~pl.col(key).is_in(covered(df, "patient_id", tcol, key).implode()))
    if len(drop_enc):
        de = drop_enc.implode()
        if rows.get("obs") is not None:
            out["obs"] = rows["obs"].filter(~pl.col("encounter_id").is_in(de))
        if rows.get("orders") is not None:
            dropped_orders = rows["orders"].filter(pl.col("encounter_id").is_in(de))["order_id"].implode()
            out["orders"] = rows["orders"].filter(~pl.col("encounter_id").is_in(de))
            if rows.get("drug_order") is not None:
                out["drug_order"] = rows["drug_order"].filter(~pl.col("order_id").is_in(dropped_orders))
    return out


# ----------------------------------------------------------------------------------------------- Parquet backend
class ParquetEMR:
    """Local write-back: Parquet parts + JSON state under `root` (default data/bulk/writeback)."""
    mode = "local"

    def __init__(self, root: Path | None = None, sim_state_dir: Path | None = None):
        wb, ss = _paths()
        self.root = Path(root) if root else wb
        self.sim_state_dir = Path(sim_state_dir) if sim_state_dir else ss

    # -- locking + state
    @contextmanager
    def locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with open(self.root / ".lock", "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def _state(self) -> dict:
        try:
            return json.load(open(self.root / "state.json"))
        except (FileNotFoundError, json.JSONDecodeError):
            return self._recover_state()

    def _recover_state(self) -> dict:
        """Rebuild counters from the parts on disk (state.json lost): ids continue above the largest care id."""
        st = {"seq": 0, "tick_seq": 0, "ids": {}}
        for t in ID_TABLES:
            key = ID_KEYS[t]
            files = list((self.root / t).glob("part-*.parquet")) + list((self.root / "deferred" / t).glob("part-*.parquet"))
            mx = pl.scan_parquet(files).select(pl.col(key).max()).collect().item() if files else None
            st["ids"][t] = max(CARE_ID_BASE, int(mx or 0))
        seqs = [int(p.stem.split("-")[1]) for p in self.root.glob("*/part-*.parquet")]
        seqs += [int(p.stem.split("-")[1]) for p in self.root.glob("deferred/*/part-*.parquet")]
        st["seq"] = max(seqs, default=0)
        st["tick_seq"] = max((int(p.stem.split("-")[1]) for p in self.root.glob("sim_tick_log/part-*.parquet")), default=0)
        return st

    def _save(self, st: dict):
        tmp = self.root / "state.json.tmp"
        json.dump(st, open(tmp, "w"), indent=1)
        os.replace(tmp, self.root / "state.json")

    def sim_time(self) -> dt.datetime:
        return current_sim_time(self.sim_state_dir)

    # -- ids
    def next_ids(self, table: str, n: int) -> list[int]:
        """n fresh ids for `table` from the care range (CARE_ID_BASE + counter). drug_order -> orders, patient -> person."""
        table = {"drug_order": "orders", "patient": "person"}.get(table, table)
        if table not in ID_TABLES:
            raise ValueError(f"no id sequence for {table}")
        if n <= 0:
            return []
        with self.locked():
            st = self._state()
            last = max(int(st["ids"].get(table, CARE_ID_BASE)), self._backend_max(table))
            ids = list(range(last + 1, last + n + 1))
            if ids[-1] >= 2**31:
                raise OverflowError(f"care id range exhausted for {table}")
            st["ids"][table] = ids[-1]
            self._save(st)
        return ids

    def _backend_max(self, table: str) -> int:
        return CARE_ID_BASE

    # -- rows
    def write(self, rows: dict[str, pl.DataFrame], tick: str = "") -> dict[str, int]:
        """Append one part per non-empty table. Returns {table: rows written} for every table given."""
        created = self.sim_time()
        frames = {t: conform(t, df, created) for t, df in rows.items() if df is not None}
        counts = {t: df.height for t, df in frames.items()}
        if not any(counts.values()):
            return counts
        with self.locked():
            st = self._state()
            st["seq"] = int(st.get("seq", 0)) + 1
            seq = st["seq"]
            self._write_parts(frames, seq)
            self._save(st)
            with open(self.root / "manifest.jsonl", "a") as fh:
                fh.write(json.dumps({"seq": seq, "tick": tick, "sim_time": created.isoformat(),
                                     "counts": {k: v for k, v in counts.items() if v}}) + "\n")
        return counts

    def _write_parts(self, frames: dict[str, pl.DataFrame], seq: int):
        for t in ALL_TABLES:
            df = frames.get(t)
            if df is None or df.height == 0:
                continue
            d = self.root / t
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / f".part-{seq:06d}.tmp"
            df.write_parquet(tmp, compression="zstd")
            os.replace(tmp, d / f"part-{seq:06d}.parquet")

    def log_tick(self, sim_time: dt.datetime, encounters_added: int, obs_added: int,
                 wall_time: dt.datetime | None = None) -> int:
        """Append one sim_tick_log row (mirrored to raw_sim_tick_log by local_extract). Returns the tick id."""
        with self.locked():
            st = self._state()
            st["tick_seq"] = int(st.get("tick_seq", 0)) + 1
            tid = st["tick_seq"]
            df = pl.DataFrame({"tick_id": [tid], "sim_time": [sim_time], "wall_time": [wall_time or dt.datetime.now()],
                               "encounters_added": [int(encounters_added)], "obs_added": [int(obs_added)]},
                              schema=TICK_SCHEMA)
            d = self.root / "sim_tick_log"
            d.mkdir(parents=True, exist_ok=True)
            df.write_parquet(d / f"part-{tid:06d}.parquet")
            self._save(st)
        return tid

    def parts(self, table: str) -> list[Path]:
        return sorted((self.root / table).glob("part-*.parquet"))

    def read(self, table: str) -> pl.DataFrame:
        """All written rows of a table (tests, care world look-ups)."""
        p = self.parts(table)
        return pl.read_parquet(p) if p else (empty(table) if table in SCHEMAS else pl.DataFrame(schema=TICK_SCHEMA))

    # -- supersede
    def supersede(self, patient_id: int, from_day: int, reason: str, at_sim_time: dt.datetime | None = None) -> int:
        """Record that the patient's pre-simulated future from `from_day` is replaced. Returns the record's seq."""
        with self.locked():
            cur = self._superseded_unlocked()
            seq = int(cur["seq"].max() or 0) + 1 if cur.height else 1
            row = pl.DataFrame({"patient_id": [int(patient_id)], "from_day": [int(from_day)], "reason": [reason],
                                "at_sim_time": [at_sim_time or self.sim_time()], "seq": [seq]}, schema=SUPERSEDED_SCHEMA)
            tmp = self.root / "superseded.parquet.tmp"
            pl.concat([cur, row]).write_parquet(tmp)
            os.replace(tmp, self.root / "superseded.parquet")
        return seq

    def _superseded_unlocked(self) -> pl.DataFrame:
        p = self.root / "superseded.parquet"
        return pl.read_parquet(p) if p.exists() else pl.DataFrame(schema=SUPERSEDED_SCHEMA)

    def superseded(self) -> pl.DataFrame:
        """patient_id, from_day, reason, at_sim_time (+ seq)."""
        return self._superseded_unlocked()

    # -- deferred (re-simulated rows dated after the current tick)
    def defer(self, rows: dict[str, pl.DataFrame], sup_seq: int, tick: str = "") -> dict[str, int]:
        """Store re-simulated rows dated in the future; the sim clock replays them when their date comes."""
        frames = {t: conform(t, df, None).with_columns(pl.lit(int(sup_seq), pl.Int64).alias("_sup"))
                  for t, df in rows.items() if df is not None and df.height}
        if not frames:
            return {}
        with self.locked():
            st = self._state()
            st["seq"] = int(st.get("seq", 0)) + 1
            seq = st["seq"]
            for t, df in frames.items():
                # date_created of a deferred row is its own event time (set when it is replayed)
                d = self.root / "deferred" / t
                d.mkdir(parents=True, exist_ok=True)
                df.write_parquet(d / f"part-{seq:06d}.parquet", compression="zstd")
            self._save(st)
            with open(self.root / "manifest.jsonl", "a") as fh:
                fh.write(json.dumps({"seq": seq, "tick": tick, "deferred": {k: v.height for k, v in frames.items()}}) + "\n")
        return {t: df.height for t, df in frames.items()}

    def deferred(self) -> dict[str, pl.LazyFrame]:
        out = {}
        for t in ALL_TABLES:
            files = sorted((self.root / "deferred" / t).glob("part-*.parquet"))
            if files:
                out[t] = pl.scan_parquet(files)
        return out


# ----------------------------------------------------------------------------------------------- MySQL backend
class MySQLEMR(ParquetEMR):
    """INSERT IGNORE into the OpenMRS MySQL tables (EMR_MODE=mysql). Supersede records, deferred rows and id counters
    stay in the local writeback directory (they are simulator state, not EMR data). Untested in cloud sessions."""
    mode = "mysql"

    def _conn(self):
        import pymysql

        from shared.config import mysql_params
        return pymysql.connect(**mysql_params("openmrs"), autocommit=False, charset="utf8mb4")

    def _backend_max(self, table: str) -> int:
        key = ID_KEYS[table]
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(f"SELECT coalesce(max({key}), %s) FROM {table} WHERE {key} >= %s", [CARE_ID_BASE, CARE_ID_BASE])
            return int(cur.fetchone()[0])
        finally:
            conn.close()

    def write(self, rows: dict[str, pl.DataFrame], tick: str = "") -> dict[str, int]:
        created = self.sim_time()
        frames = {t: conform(t, df, created) for t, df in rows.items() if df is not None}
        conn = self._conn()
        counts = {t: df.height for t, df in frames.items()}
        try:
            conn.begin()
            cur = conn.cursor()
            for t in ALL_TABLES:
                df = frames.get(t)
                if df is None or df.height == 0:
                    continue
                cols = COLUMNS[t]
                sql = f"INSERT IGNORE INTO {t} ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))})"
                data = df.select(cols).rows()
                for i in range(0, len(data), 5000):
                    cur.executemany(sql, data[i:i + 5000])
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return counts

    def log_tick(self, sim_time: dt.datetime, encounters_added: int, obs_added: int,
                 wall_time: dt.datetime | None = None) -> int:
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute("INSERT INTO sim_tick_log (sim_time, wall_time, encounters_added, obs_added) VALUES (%s, %s, %s, %s)",
                        [sim_time, wall_time or dt.datetime.now(), encounters_added, obs_added])
            conn.commit()
            return int(cur.lastrowid)
        finally:
            conn.close()


# ----------------------------------------------------------------------------------------------- module API
def get_adapter() -> ParquetEMR:
    mode = os.environ.get("EMR_MODE", "local").lower()
    if mode == "mysql":
        return MySQLEMR()
    if mode != "local":
        raise ValueError(f"EMR_MODE must be local or mysql, not {mode!r}")
    return ParquetEMR()


def write(rows: dict[str, pl.DataFrame], tick: str = "") -> dict[str, int]:
    return get_adapter().write(rows, tick)


def next_ids(table: str, n: int) -> list[int]:
    return get_adapter().next_ids(table, n)


def supersede(patient_id: int, from_day: int, reason: str) -> int:
    return get_adapter().supersede(patient_id, from_day, reason)


def superseded() -> pl.DataFrame:
    return get_adapter().superseded()
