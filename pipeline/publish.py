"""Step 11: blue/green publish (SPEC §10.2, ADR-3). Builds the inactive serve file, then swaps current.json atomically."""
from __future__ import annotations

import datetime as dt
import json
import os

from shared.config import ANALYTICS_DIR

CURRENT = ANALYTICS_DIR / "current.json"
SERVE_PREFIXES = ("mart_", "pt_", "ml_")
SERVE_EXTRA = ["core_dim_location", "core_gc_case", "core_gi_cohort", "core_facility_events", "pipeline_run_log",
               "ref_district", "dq_raw_results", "dq_mart_results", "mart_stage_tier_test"]


def current() -> dict | None:
    try:
        return json.load(open(CURRENT))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def publish(con, run_id: int, sim_time: dt.datetime, deltas: dict) -> dict:
    cur = current()
    active = cur["active"] if cur else "green"
    target = "blue" if active == "green" else "green"
    path = ANALYTICS_DIR / f"serve_{target}.duckdb"
    tmp = ANALYTICS_DIR / f"serve_{target}.building.duckdb"
    for p in (tmp, ANALYTICS_DIR / f"serve_{target}.building.duckdb.wal"):
        if p.exists():
            p.unlink()
    tables = [r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' "
                                        "AND table_catalog = current_database()").fetchall()]
    keep = [t for t in tables if t.startswith(SERVE_PREFIXES) or t in SERVE_EXTRA]
    con.execute(f"ATTACH '{tmp.as_posix()}' AS serve")
    try:
        for t in keep:
            con.execute(f"CREATE TABLE serve.{t} AS SELECT * FROM main.{t}")
        changed = _changed(deltas)
        con.execute("CREATE TABLE serve.serve_meta AS SELECT ? AS run_id, ? AS sim_time, now() AS published_at, ? AS changed",
                    [run_id, sim_time, json.dumps(changed)])
    finally:
        con.execute("DETACH serve")
    os.replace(tmp, path)  # the API only ever opens the inactive colour after current.json flips
    info = {"active": target, "run_id": run_id, "published_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sim_time": sim_time.strftime("%Y-%m-%dT%H:%M:%S"), "changed": _changed(deltas), "file": path.name}
    tmpj = CURRENT.with_suffix(".json.tmp")
    json.dump(info, open(tmpj, "w"))
    os.replace(tmpj, CURRENT)
    return info


def _changed(deltas: dict) -> list[str]:
    if not deltas:
        return ["kpis", "rates", "trends", "geo", "patients", "alerts", "warning", "quality", "models"]
    out = ["kpis", "rates", "trends", "geo", "warning", "quality"]
    if any(deltas.get(t) for t in ("obs", "encounter", "orders")):
        out += ["patients", "alerts"]
    return out
