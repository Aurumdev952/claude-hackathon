"""Step 1: raw_* <- MySQL (incremental on id watermarks) or <- Parquet (bootstrap). SPEC §10.3."""
from __future__ import annotations

import time

from shared.config import BULK_DIR

from .db import attach_mysql

CARE_ID_BASE = 1_900_000_000  # care.emr.CARE_ID_BASE: write-back rows created by the care engine / care world

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
        mx = con.execute(f"SELECT coalesce(max({key}), 0) FROM raw_{t} WHERE {key} < {CARE_ID_BASE}").fetchone()[0]
        con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, ?, now())", [t, int(mx)])
        con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, ?, now())", [f"{t}#care", CARE_ID_BASE - 1])
    con.execute("DROP TABLE IF EXISTS etl_local_parts")  # raw_* rebuilt: every write-back part is new again
    log(f"  bootstrap from parquet done in {time.time() - t0:.1f}s")


def incremental_extract(con, log=print) -> dict[str, int]:
    ensure_watermarks(con)
    attach_mysql(con)
    new = {}
    try:
        for t, key in WATERMARKED.items():
            n0 = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0]
            cols = [r[0] for r in con.execute(f"DESCRIBE raw_{t}").fetchall()]
            src_cols = {r[0] for r in con.execute(f"DESCRIBE src.{t}").fetchall()}
            cl = ", ".join(c for c in cols if c in src_cols)
            # two id ranges (v3 contract §2): generator/replayed ids below CARE_ID_BASE, care-created ids above it
            for wtbl, lo, hi in ((t, 0, CARE_ID_BASE), (f"{t}#care", CARE_ID_BASE - 1, 2**63 - 1)):
                wm = con.execute("SELECT last_id FROM etl_watermark WHERE tbl = ?", [wtbl]).fetchone()
                wm = max(int(wm[0]), lo) if wm else lo
                con.execute(f"INSERT INTO raw_{t} ({cl}) SELECT {cl} FROM src.{t} WHERE {key} > {wm} AND {key} < {hi}")
                mx = con.execute(f"SELECT max({key}) FROM raw_{t} WHERE {key} > {wm} AND {key} < {hi}").fetchone()[0]
                if mx is not None:
                    con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, ?, now())", [wtbl, int(mx)])
            n1 = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0]
            new[t] = n1 - n0
        con.execute("CREATE OR REPLACE TABLE raw_sim_tick_log AS SELECT * FROM src.sim_tick_log")
    finally:
        con.execute("DETACH src")
    return new


def local_extract(con, log=print) -> dict[str, int]:
    """MySQL-free extract (v3 contract §2): load write-back Parquet parts (data/bulk/writeback/<table>/part-*.parquet)
    not yet ingested. Only ids not already in raw_<t> are inserted (anti-join), so a part replayed twice or a row that
    also came through the bootstrap is never duplicated. sim_tick_log parts are appended to raw_sim_tick_log."""
    root = BULK_DIR / "writeback"
    con.execute("CREATE TABLE IF NOT EXISTS etl_local_parts (part_path VARCHAR PRIMARY KEY, tbl VARCHAR, n_rows BIGINT, "
                "ingested_at TIMESTAMP)")
    seen = {r[0] for r in con.execute("SELECT part_path FROM etl_local_parts").fetchall()}
    new: dict[str, int] = {}

    def todo(name):
        parts = sorted((root / name).glob("part-*.parquet"))
        return [p for p in parts if p.relative_to(BULK_DIR).as_posix() not in seen]

    def mark(name, parts):
        for p in parts:
            con.execute("INSERT OR REPLACE INTO etl_local_parts VALUES (?, ?, ?, now())",
                        [p.relative_to(BULK_DIR).as_posix(), name, None])

    for t, key in WATERMARKED.items():
        parts = todo(t)
        if not parts:
            new[t] = 0
            continue
        files = "[" + ", ".join(f"'{p.as_posix()}'" for p in parts) + "]"
        n0 = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0]
        con.execute(f"""INSERT INTO raw_{t} BY NAME
                        SELECT s.* FROM (SELECT DISTINCT ON ({key}) * FROM read_parquet({files}, union_by_name = true)) s
                        ANTI JOIN raw_{t} r ON s.{key} = r.{key}""")
        new[t] = con.execute(f"SELECT count(*) FROM raw_{t}").fetchone()[0] - n0
        mark(t, parts)
    parts = todo("sim_tick_log")
    if parts:
        files = "[" + ", ".join(f"'{p.as_posix()}'" for p in parts) + "]"
        con.execute(f"""INSERT INTO raw_sim_tick_log BY NAME
                        SELECT s.* FROM read_parquet({files}) s ANTI JOIN raw_sim_tick_log r ON s.tick_id = r.tick_id""")
        mark("sim_tick_log", parts)
    new["sim_ticks"] = len(parts)
    log(f"  local extract: {sum(v for k, v in new.items() if k != 'sim_ticks'):,} rows from write-back "
        f"({', '.join(f'{k} +{v}' for k, v in new.items() if v)})")
    return new
