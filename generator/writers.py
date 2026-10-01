"""Row -> Polars frames -> Parquet (+ TSV for MySQL LOAD DATA). Splits bulk history (<= history_end) from the
future (> history_end), which the simulator replays in time order (docs/decisions.md D-07)."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import polars as pl

from .context import HIST_END, MIN_PER_DAY

HIST_END_MIN = (HIST_END + 1) * MIN_PER_DAY - 1

# column order == MySQL column order used in LOAD DATA
COLUMNS = {
    "person": ["person_id", "gender", "birthdate", "birthdate_estimated", "dead", "death_date", "cause_of_death",
               "creator", "date_created", "voided", "uuid"],
    "person_name": ["person_name_id", "person_id", "preferred", "given_name", "family_name", "creator", "date_created",
                    "voided", "uuid"],
    "person_address": ["person_address_id", "person_id", "preferred", "country", "state_province", "county_district",
                       "address3", "latitude", "longitude", "start_date", "end_date", "creator", "date_created",
                       "voided", "uuid"],
    "person_attribute": ["person_attribute_id", "person_id", "value", "person_attribute_type_id", "creator",
                         "date_created", "voided", "uuid"],
    "patient": ["patient_id", "creator", "date_created", "voided"],
    "patient_identifier": ["patient_identifier_id", "patient_id", "identifier", "identifier_type", "preferred",
                           "location_id", "creator", "date_created", "voided", "uuid"],
    "visit": ["visit_id", "patient_id", "visit_type_id", "date_started", "date_stopped", "location_id", "creator",
              "date_created", "voided", "uuid"],
    "encounter": ["encounter_id", "encounter_type", "patient_id", "location_id", "visit_id", "encounter_datetime",
                  "creator", "date_created", "voided", "uuid"],
    "obs": ["obs_id", "person_id", "concept_id", "encounter_id", "order_id", "obs_datetime", "location_id",
            "obs_group_id", "value_coded", "value_numeric", "value_text", "value_datetime", "comments", "status",
            "creator", "date_created", "voided", "void_reason", "uuid"],
    "orders": ["order_id", "order_type_id", "concept_id", "patient_id", "encounter_id", "date_activated",
               "date_stopped", "urgency", "creator", "date_created", "voided", "uuid"],
    "drug_order": ["order_id", "drug_inventory_id", "dose", "dose_units", "frequency", "duration", "duration_units",
                   "quantity", "num_refills"],
    "patient_program": ["patient_program_id", "patient_id", "program_id", "date_enrolled", "date_completed",
                        "location_id", "outcome_concept_id", "creator", "date_created", "voided", "uuid"],
}
PATIENT_TABLES = ["person", "person_name", "person_address", "person_attribute", "patient", "patient_identifier"]
CLINICAL_TABLES = ["visit", "encounter", "obs", "orders", "drug_order", "patient_program"]
ALL_TABLES = PATIENT_TABLES + CLINICAL_TABLES


def uuids(n: int, rng: np.random.Generator) -> list[str]:
    if n == 0:
        return []
    h = rng.bytes(16 * n).hex()
    return [f"{h[i:i+8]}-{h[i+8:i+12]}-4{h[i+13:i+16]}-a{h[i+17:i+20]}-{h[i+20:i+32]}" for i in range(0, 32 * n, 32)]


def _ts(col: str) -> pl.Expr:
    return pl.from_epoch(pl.col(col).cast(pl.Int64) * 60, time_unit="s").alias(col)


def _date(col: str) -> pl.Expr:
    return pl.col(col).cast(pl.Int32).cast(pl.Date).alias(col)


def _df(rows, names, schema) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=list(zip(names, schema)), orient="row")


def chunk_frames(out: dict, chunk: int, seed: int) -> dict[str, pl.DataFrame]:
    """Build one frame per table with a boolean `_future` column (not written to MySQL)."""
    rng = np.random.default_rng(seed * 1009 + chunk)
    rec, pers = out["rec"], out["persons"]
    base = chunk * 10**6
    F: dict[str, pl.DataFrame] = {}

    # ---- clinical
    visits = _df(rec["visits"], ["visit_id", "patient_id", "visit_type_id", "t0", "t1", "location_id"],
                 [pl.Int64, pl.Int64, pl.Int16, pl.Int64, pl.Int64, pl.Int32])
    visits = visits.with_columns(pl.col("t0").alias("date_started"), pl.col("t1").alias("date_stopped"),
                                 pl.col("t0").alias("date_created"), (pl.col("t0") > HIST_END_MIN).alias("_future"))
    fut_visits = set(visits.filter(pl.col("_future"))["visit_id"].to_list())
    encs = _df(rec["encs"], ["encounter_id", "encounter_type", "patient_id", "location_id", "visit_id", "t", "keep_bulk"],
               [pl.Int64, pl.Int16, pl.Int64, pl.Int32, pl.Int64, pl.Int64, pl.Int8])
    encs = encs.with_columns(
        pl.when(pl.col("keep_bulk") == 1).then(False)
        .when(pl.col("visit_id").is_not_null()).then(pl.col("visit_id").is_in(list(fut_visits)))
        .otherwise(pl.col("t") > HIST_END_MIN).alias("_future"),
        pl.col("t").alias("encounter_datetime"), (pl.col("t") + 7).alias("date_created"))
    fut_enc = encs.filter(pl.col("_future")).select("encounter_id")
    obs = _df(rec["obs"], ["obs_id", "person_id", "concept_id", "encounter_id", "order_id", "t", "location_id",
                           "obs_group_id", "value_coded", "value_numeric", "value_text", "status", "voided", "created"],
              [pl.Int64, pl.Int64, pl.Int32, pl.Int64, pl.Int64, pl.Int64, pl.Int32, pl.Int64, pl.Int32, pl.Float64,
               pl.Utf8, pl.Utf8, pl.Int8, pl.Int64])
    obs = obs.with_columns(pl.col("encounter_id").is_in(fut_enc["encounter_id"]).alias("_future"),
                           pl.col("t").alias("obs_datetime"), pl.col("created").alias("date_created"),
                           pl.when(pl.col("voided") == 1).then(pl.lit("Entered in error")).otherwise(None).alias("void_reason"))
    orders = _df(rec["orders"], ["order_id", "order_type_id", "concept_id", "patient_id", "encounter_id", "t", "stopped", "urgency"],
                 [pl.Int64, pl.Int16, pl.Int32, pl.Int64, pl.Int64, pl.Int64, pl.Int64, pl.Utf8])
    orders = orders.with_columns(pl.col("encounter_id").is_in(fut_enc["encounter_id"]).alias("_future"),
                                 pl.col("t").alias("date_activated"), pl.col("stopped").alias("date_stopped"),
                                 pl.col("t").alias("date_created"))
    fut_orders = orders.filter(pl.col("_future")).select("order_id")
    drug = _df(rec["drug_orders"], ["order_id", "drug_inventory_id", "dose", "dose_units", "frequency", "duration",
                                    "duration_units", "quantity", "num_refills"],
               [pl.Int64, pl.Int32, pl.Float64, pl.Int32, pl.Utf8, pl.Int32, pl.Utf8, pl.Float64, pl.Int32])
    drug = drug.with_columns(pl.col("order_id").is_in(fut_orders["order_id"]).alias("_future"))
    prog = _df(rec["programs"], ["patient_id", "program_id", "t", "completed", "location_id"],
               [pl.Int64, pl.Int16, pl.Int64, pl.Int64, pl.Int32])
    prog = prog.with_row_index("patient_program_id", offset=base + 1).with_columns(
        pl.col("patient_program_id").cast(pl.Int64), pl.col("t").alias("date_enrolled"),
        pl.col("completed").alias("date_completed"), pl.lit(None, pl.Int32).alias("outcome_concept_id"),
        pl.col("t").alias("date_created"), (pl.col("t") > HIST_END_MIN).alias("_future"))

    # ---- person-level
    person = _df(pers["person"], ["person_id", "gender", "birth", "birthdate_estimated", "dead", "death_day", "cause_of_death", "t0"],
                 [pl.Int64, pl.Utf8, pl.Int32, pl.Int8, pl.Int8, pl.Int32, pl.Int32, pl.Int64])
    person = person.with_columns((pl.col("t0") > HIST_END_MIN).alias("_future"))
    # deaths after history_end reach the EMR only via the simulator's DEATH encounter (insert-only rule)
    late = pl.col("death_day") > HIST_END
    person = person.with_columns(pl.when(late).then(0).otherwise(pl.col("dead")).alias("dead"),
                                 pl.when(late).then(None).otherwise(pl.col("death_day")).alias("death_day"),
                                 pl.when(late).then(None).otherwise(pl.col("cause_of_death")).alias("cause_of_death"))
    person = person.with_columns(_date("birth").alias("birthdate"),
                                 (pl.col("death_day").cast(pl.Int64) * MIN_PER_DAY + 600).alias("death_date"),
                                 pl.col("t0").alias("date_created"))
    fut_p = person.filter(pl.col("_future")).select("person_id")

    def pflag(df):
        return df.with_columns(pl.col("person_id").is_in(fut_p["person_id"]).alias("_future"))

    pname = _df(pers["person_name"], ["person_id", "given_name", "family_name", "t0"], [pl.Int64, pl.Utf8, pl.Utf8, pl.Int64])
    pname = pflag(pname).with_row_index("person_name_id", offset=base + 1).with_columns(
        pl.col("person_name_id").cast(pl.Int64), pl.lit(1, pl.Int8).alias("preferred"), pl.col("t0").alias("date_created"))
    addr = _df(pers["person_address"], ["person_id", "preferred", "county_district", "address3", "state_province",
                                        "latitude", "longitude", "start", "end", "t0"],
               [pl.Int64, pl.Int8, pl.Utf8, pl.Utf8, pl.Utf8, pl.Float64, pl.Float64, pl.Int64, pl.Int64, pl.Int64])
    addr = pflag(addr).with_columns((pl.col("_future") | (pl.col("start") > HIST_END_MIN)).alias("_future"))
    addr = addr.with_row_index("person_address_id", offset=base + 1).with_columns(
        pl.col("person_address_id").cast(pl.Int64), pl.lit("Rwanda").alias("country"),
        pl.col("start").alias("start_date"),
        pl.when(pl.col("end") > HIST_END_MIN).then(None).otherwise(pl.col("end")).alias("end_date"),
        pl.col("t0").alias("date_created"),
        pl.col("latitude").cast(pl.Utf8), pl.col("longitude").cast(pl.Utf8))
    pattr = _df(pers["person_attribute"], ["person_id", "value", "person_attribute_type_id", "t0"],
                [pl.Int64, pl.Utf8, pl.Int16, pl.Int64])
    pattr = pflag(pattr).with_row_index("person_attribute_id", offset=base + 1).with_columns(
        pl.col("person_attribute_id").cast(pl.Int64), pl.col("t0").alias("date_created"))
    patient = _df(pers["patient"], ["person_id", "t0"], [pl.Int64, pl.Int64])
    patient = pflag(patient).with_columns(pl.col("person_id").alias("patient_id"), pl.col("t0").alias("date_created"))
    ident = _df(pers["patient_identifier"], ["person_id", "identifier", "identifier_type", "preferred", "location_id", "t0"],
                [pl.Int64, pl.Utf8, pl.Int16, pl.Int8, pl.Int32, pl.Int64])
    ident = pflag(ident).with_row_index("patient_identifier_id", offset=base * 2 + 1).with_columns(
        pl.col("patient_identifier_id").cast(pl.Int64), pl.col("person_id").alias("patient_id"), pl.col("t0").alias("date_created"))

    raw = {"visit": visits, "encounter": encs, "obs": obs, "orders": orders, "drug_order": drug, "patient_program": prog,
           "person": person, "person_name": pname, "person_address": addr, "person_attribute": pattr,
           "patient": patient, "patient_identifier": ident}
    for name, df in raw.items():
        cols = COLUMNS[name]
        add = []
        if "creator" in cols:
            add.append(pl.lit(1, pl.Int16).alias("creator"))
        if "voided" in cols and "voided" not in df.columns:
            add.append(pl.lit(0, pl.Int8).alias("voided"))
        if "uuid" in cols:
            add.append(pl.Series("uuid", uuids(df.height, rng)))
        for c in ("value_datetime", "comments"):
            if c in cols and c not in df.columns:
                add.append(pl.lit(None, pl.Utf8).alias(c))
        if name == "drug_order":
            add = []
        df = df.with_columns(add) if add else df
        # epoch-minute columns -> datetimes
        conv = [c for c in ("date_started", "date_stopped", "date_created", "encounter_datetime", "obs_datetime",
                            "date_activated", "date_enrolled", "date_completed", "start_date", "end_date",
                            "death_date") if c in cols]
        df = df.with_columns([_ts(c) for c in conv])
        F[name] = df.select(cols + ["_future"])
    return F


def write_chunk(F: dict[str, pl.DataFrame], bulk_dir: Path, chunk: int):
    for name, df in F.items():
        b = df.filter(~pl.col("_future")).drop("_future")
        f = df.filter(pl.col("_future")).drop("_future")
        for sub, part in (("parquet", b), ("future_parts", f)):
            p = bulk_dir / sub / name
            p.mkdir(parents=True, exist_ok=True)
            part.write_parquet(p / f"part-{chunk:04d}.parquet", compression="zstd")


def finalize_future(bulk_dir: Path) -> dict:
    """Re-number future rows so their ids sit above every bulk id, increasing with time (ETL watermarks rely on it)."""
    fp = bulk_dir / "future_parts"
    out = bulk_dir / "future"
    out.mkdir(parents=True, exist_ok=True)

    def load(name, sub):
        g = list((bulk_dir / sub / name).glob("*.parquet"))
        return pl.concat([pl.read_parquet(x) for x in g], how="vertical_relaxed") if g else None

    maxes = {}
    for name, key in (("person", "person_id"), ("visit", "visit_id"), ("encounter", "encounter_id"), ("obs", "obs_id"),
                      ("orders", "order_id"), ("person_name", "person_name_id"), ("person_address", "person_address_id"),
                      ("person_attribute", "person_attribute_id"), ("patient_identifier", "patient_identifier_id"),
                      ("patient_program", "patient_program_id")):
        g = list((bulk_dir / "parquet" / name).glob("*.parquet"))
        mx = pl.scan_parquet(g).select(pl.col(key).max()).collect().item() if g else None  # lazy: never load bulk obs
        maxes[name] = int(mx) if mx is not None else 0

    fut = {n: load(n, "future_parts") for n in ALL_TABLES}

    def remap(df, key, time_col, start):
        df = df.sort([time_col, key])
        m = df.select(pl.col(key).alias("old"), (pl.int_range(0, df.height) + start + 1).cast(pl.Int64).alias("new"))
        return df.with_columns(m["new"].alias(key)), m

    maps = {}
    # persons: only persons first seen in the future get new ids
    fp_person, maps["person"] = remap(fut["person"], "person_id", "date_created", maxes["person"])
    pmap = maps["person"]
    fut["person"] = fp_person

    def map_col(df, col, m):
        if df is None:
            return df
        return (df.join(m.rename({"old": col, "new": "__n"}), on=col, how="left")
                .with_columns(pl.coalesce(pl.col("__n"), pl.col(col)).alias(col)).drop("__n"))

    for n, c in (("person_name", "person_id"), ("person_address", "person_id"), ("person_attribute", "person_id"),
                 ("patient", "patient_id"), ("patient_identifier", "patient_id"), ("visit", "patient_id"),
                 ("encounter", "patient_id"), ("obs", "person_id"), ("orders", "patient_id"), ("patient_program", "patient_id")):
        fut[n] = map_col(fut[n], c, pmap)
    fut["visit"], vm = remap(fut["visit"], "visit_id", "date_started", maxes["visit"])
    fut["encounter"] = map_col(fut["encounter"], "visit_id", vm)
    fut["encounter"], em = remap(fut["encounter"], "encounter_id", "encounter_datetime", maxes["encounter"])
    fut["obs"] = map_col(fut["obs"], "encounter_id", em)
    fut["orders"] = map_col(fut["orders"], "encounter_id", em)
    fut["orders"], om = remap(fut["orders"], "order_id", "date_activated", maxes["orders"])
    fut["obs"] = map_col(fut["obs"], "order_id", om)
    fut["drug_order"] = map_col(fut["drug_order"], "order_id", om)
    # obs: parent rows must get ids before children -> sort by (datetime, old id) keeps parents first (created first)
    fut["obs"], obm = remap(fut["obs"], "obs_id", "obs_datetime", maxes["obs"])
    fut["obs"] = map_col(fut["obs"], "obs_group_id", obm)
    for n, key, tc in (("person_name", "person_name_id", "date_created"), ("person_address", "person_address_id", "date_created"),
                       ("person_attribute", "person_attribute_id", "date_created"),
                       ("patient_identifier", "patient_identifier_id", "date_created"),
                       ("patient_program", "patient_program_id", "date_enrolled")):
        fut[n], _ = remap(fut[n], key, tc, maxes[n])
    counts = {}
    for n, df in fut.items():
        df.write_parquet(out / f"{n}.parquet", compression="zstd")
        counts[n] = df.height
    pmap.write_parquet(out / "_person_id_map.parquet")
    return {"future_rows": counts, "bulk_max_ids": maxes}


def write_tsv(df: pl.DataFrame, path: Path):
    """MySQL LOAD DATA format: tab separated, \\N for NULL, no header."""
    df.write_csv(path, separator="\t", include_header=False, null_value="\\N",
                 datetime_format="%Y-%m-%d %H:%M:%S", date_format="%Y-%m-%d", quote_style="never")
