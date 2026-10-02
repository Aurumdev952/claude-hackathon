"""F1 #13: MySQL-mode incremental extract must not lose care-range rows that reach the source after rows with higher
ids (deferred re-simulated rows get their ids when the intervention runs, but are inserted when the clock replays them).
A fake `src` (an attached in-memory DuckDB) stands in for MySQL."""
from __future__ import annotations

import duckdb

from generator.writers import SCHEMAS
from pipeline import extract

BASE = extract.CARE_ID_BASE


def _ddl(t: str) -> str:
    def typ(x):
        x = str(x)
        if x.startswith("Datetime"):
            return "TIMESTAMP"
        if x == "Date":
            return "DATE"
        if x == "String":
            return "VARCHAR"
        return "BIGINT" if "Int" in x else ("BOOLEAN" if x == "Boolean" else "DOUBLE")
    return ", ".join(f'"{c}" {typ(d)}' for c, d in SCHEMAS[t].items())


def _setup(monkeypatch):
    con = duckdb.connect()
    con.execute("ATTACH ':memory:' AS fake")
    for t in extract.WATERMARKED:
        con.execute(f"CREATE TABLE raw_{t} ({_ddl(t)})")
        con.execute(f"CREATE TABLE fake.{t} ({_ddl(t)})")
    con.execute("CREATE TABLE fake.sim_tick_log (tick_id INTEGER, sim_time TIMESTAMP, wall_time TIMESTAMP, "
                "encounters_added INTEGER, obs_added INTEGER)")
    extract.ensure_watermarks(con)
    for t in extract.WATERMARKED:
        con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, 0, now())", [t])
        con.execute("INSERT OR REPLACE INTO etl_watermark VALUES (?, ?, now())", [f"{t}#care", BASE - 1])
    con.execute("DETACH fake")
    state = {"db": None}

    def attach(c, alias="src"):
        c.execute(f"ATTACH '{state['db']}' AS {alias}")

    monkeypatch.setattr(extract, "attach_mysql", attach)
    return con, state


def _src(path, enc_ids):
    s = duckdb.connect(str(path))
    for t in extract.WATERMARKED:
        s.execute(f"CREATE TABLE IF NOT EXISTS {t} ({_ddl(t)})")
    s.execute("CREATE TABLE IF NOT EXISTS sim_tick_log (tick_id INTEGER, sim_time TIMESTAMP, wall_time TIMESTAMP, "
              "encounters_added INTEGER, obs_added INTEGER)")
    for i in enc_ids:
        s.execute("INSERT INTO encounter (encounter_id, encounter_type, patient_id, encounter_datetime) "
                  "VALUES (?, 3, 1, TIMESTAMP '2026-07-02 10:00')", [i])
    s.close()


def test_late_care_range_rows_are_extracted(tmp_path, monkeypatch):
    con, state = _setup(monkeypatch)
    state["db"] = tmp_path / "src.duckdb"
    _src(state["db"], [100, BASE + 5])                       # tick 1: a replayed row and a care row
    assert extract.incremental_extract(con)["encounter"] == 2
    _src(state["db"], [101, BASE + 3, BASE + 7])             # tick 2: a deferred row (id 3, allocated earlier) arrives
    assert extract.incremental_extract(con)["encounter"] == 3
    ids = sorted(r[0] for r in con.execute("SELECT encounter_id FROM raw_encounter").fetchall())
    assert ids == [100, 101, BASE + 3, BASE + 5, BASE + 7]
    assert extract.incremental_extract(con)["encounter"] == 0   # nothing twice
    wm = dict(con.execute("SELECT tbl, last_id FROM etl_watermark WHERE tbl LIKE 'encounter%'").fetchall())
    assert wm == {"encounter": 101, "encounter#care": BASE + 7}
