"""Bulk-load MySQL (SPEC §8.11 step 7): DDL -> reference tables -> LOAD DATA LOCAL INFILE per TSV -> indexes."""
from __future__ import annotations

import time
from pathlib import Path

import polars as pl
import pymysql

from shared.config import SIM_STATE_DIR, mysql_params

from .writers import ALL_TABLES, COLUMNS, write_tsv

SQL_DIR = Path(__file__).parent / "sql"


def _exec_script(cur, text: str):
    """Run a ;-separated SQL script. `--` comments are stripped first (they may contain semicolons)."""
    import re
    clean = "\n".join(re.sub(r"--.*$", "", ln) for ln in text.splitlines())
    for stmt in (s.strip() for s in clean.split(";")):
        if stmt:
            cur.execute(stmt)


def connect(database: str | None = "openmrs", **kw):
    p = mysql_params(database)
    return pymysql.connect(**p, local_infile=True, autocommit=True, charset="utf8mb4", **kw)


def load_all(bulk_dir: Path, ref: dict[str, pl.DataFrame], log=print):
    t0 = time.time()
    conn = connect(None)
    cur = conn.cursor()
    cur.execute("DROP DATABASE IF EXISTS openmrs")
    ddl = (SQL_DIR / "ddl.sql").read_text()
    _exec_script(cur, ddl)
    cur.execute("USE openmrs")
    cur.execute("SET foreign_key_checks=0")
    cur.execute("SET unique_checks=0")
    for name, df in ref.items():
        cols = df.columns
        rows = [tuple(r) for r in df.iter_rows()]
        if rows:
            cur.executemany(f"INSERT INTO {name} ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))})", rows)
    log(f"reference tables loaded ({time.time() - t0:.1f}s)")
    for big in ("obs", "encounter", "visit", "orders", "drug_order", "person_attribute", "patient_identifier"):
        cur.execute(f"ALTER TABLE {big} ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8")
    tmp = bulk_dir / "_tsv_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    for name in ALL_TABLES:
        n = 0
        for part in sorted((bulk_dir / "parquet" / name).glob("*.parquet")):
            f = tmp / f"{name}-{part.stem}.tsv"
            write_tsv(pl.read_parquet(part).select(COLUMNS[name]), f)
            cur.execute(f"LOAD DATA LOCAL INFILE '{f.as_posix()}' INTO TABLE {name} CHARACTER SET utf8mb4 "
                        f"FIELDS TERMINATED BY '\\t' LINES TERMINATED BY '\\n' ({','.join(COLUMNS[name])})")
            n += cur.rowcount
            f.unlink()
        log(f"  {name}: {n:,} rows ({time.time() - t0:.1f}s)")
    # the simulator inserts at random positions of the uuid / person indexes; sorted index builds pack pages 100% full,
    # so every live insert would split a page (~130 MB per simulated day at scale 1.0). Leave 20% free (D-35).
    try:
        cur.execute("SET GLOBAL innodb_fill_factor = 80")
    except pymysql.MySQLError:
        log("  (no privilege to set innodb_fill_factor; indexes built full)")
    _exec_script(cur, (SQL_DIR / "indexes.sql").read_text())
    try:
        cur.execute("SET GLOBAL innodb_fill_factor = 100")
    except pymysql.MySQLError:
        pass
    cur.execute("SET foreign_key_checks=1")
    cur.execute("SET unique_checks=1")
    # ETL user (read-only)
    for stmt in ("CREATE USER IF NOT EXISTS 'etl'@'%' IDENTIFIED BY 'change_me'",
                 "GRANT SELECT ON openmrs.* TO 'etl'@'%'"):
        try:
            cur.execute(stmt)
        except pymysql.MySQLError:
            pass
    conn.close()
    # the database is back at history end: a simulator clock left from an earlier run would skip that window
    for f in ("state.json", "last_tick.json"):
        (SIM_STATE_DIR / f).unlink(missing_ok=True)
    log(f"MySQL load complete in {time.time() - t0:.1f}s")
