"""Step 1: raw_* <- MySQL (incremental on id watermarks) or <- Parquet (bootstrap). SPEC §10.3."""
from __future__ import annotations

import time

from shared.config import BULK_DIR

from .db import attach_mysql

# table -> watermark key (insert-only source, so id watermarks are sufficient; D-07 keeps future ids above bulk ids)
WATERMARKED = {
    "person": "person_id", "person_name": "person_name_id", "person_address": "person_address_id",
    "person_attribute": "person_attribute_id", "patient": "patient_id", "patient_identifier": "patient_identifier_id",
    "visit": "visit_id", "encounter": "encounter_id", "obs": "obs_id", "orders": "order_id", "drug_order": "order_id",
    "patient_program": "patient_program_id",
}
REFERENCE = ["concept", "concept_class", "concept_datatype", "concept_name", "concept_numeric", "concept_answer", "concept_reference_term",
             "concept_reference_map", "location", "location_ext", "encounter_type", "visit_type", "order_type", "drug",
             "program", "person_attribute_type", "patient_identifier_type"]


def ensure_watermarks(con):
    con.execute("CREATE TABLE IF NOT EXISTS etl_watermark (tbl VARCHAR PRIMARY KEY, last_id BIGINT, updated_at TIMESTAMP)")


def bootstrap_from_parquet(con, log=print):
    """Initial load from the generator's Parquet copy (SPEC §10.3), then watermarks = max(id) in MySQL."""
    ensure_watermarks(con)
    t0 = time.time()
    for t in list(WATERMARKED) + REFERENCE:
        src = (BULK_DIR / "parquet" / t).as_posix()
        con.execute(f"CREATE OR REPLACE TABLE raw_{t} AS SELECT * FROM read_parquet('{src}/*.parquet')")
    con.execute("CREATE OR REPLACE TABLE raw_sim_tick_log (tick_id INTEGER, sim_time TIMESTAMP, wall_time TIMESTAMP, "
                "encounters_added INTEGER, obs_added INTEGER)")
    # watermarks = max ids of the bulk Parquet copy; identical to MySQL's bulk maxima by construction (the loader
    # reads the same files), so bootstrap does not need MySQL to be up or fully loaded
    for t, key in WATERMARKED.items():
        mx = con.execute(f"SELECT coalesce(max({key}), 0) FROM raw_{t}").fetchone()[0]
        con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, ?, now())", [t, int(mx)])
    log(f"  bootstrap from parquet done in {time.time() - t0:.1f}s")


def incremental_extract(con, log=print) -> dict[str, int]:
    ensure_watermarks(con)
    attach_mysql(con)
    new = {}
    try:
        for t, key in WATERMARKED.items():
            wm = con.execute("SELECT last_id FROM etl_watermark WHERE tbl = ?", [t]).fetchone()
            wm = wm[0] if wm else 0
            n0 = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0]
            cols = [r[0] for r in con.execute(f"DESCRIBE raw_{t}").fetchall()]
            src_cols = {r[0] for r in con.execute(f"DESCRIBE src.{t}").fetchall()}
            cl = ", ".join(c for c in cols if c in src_cols)
            con.execute(f"INSERT INTO raw_{t} ({cl}) SELECT {cl} FROM src.{t} WHERE {key} > {int(wm)}")
            n1 = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0]
            new[t] = n1 - n0
            if new[t]:
                mx = con.execute(f"SELECT max({key}) FROM raw_{t}").fetchone()[0]
                con.execute("UPDATE etl_watermark SET last_id = ?, updated_at = now() WHERE tbl = ?", [int(mx), t])
        con.execute("CREATE OR REPLACE TABLE raw_sim_tick_log AS SELECT * FROM src.sim_tick_log")
    finally:
        con.execute("DETACH src")
    return new
