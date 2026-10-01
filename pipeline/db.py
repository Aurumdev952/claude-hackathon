"""DuckDB connection helpers for the pipeline (work.duckdb is pipeline-only, read-write)."""
from __future__ import annotations

import os
from pathlib import Path

import duckdb

from shared.config import ANALYTICS_DIR, ROOT, mysql_params

SQL_DIR = Path(__file__).parent / "sql"
WORK_DB = ANALYTICS_DIR / "work.duckdb"


def load_extensions(con: duckdb.DuckDBPyConnection, *names: str):
    """Extensions come from PyPI wheels (D-14); fall back to the normal installer if those are absent."""
    try:
        import duckdb_extensions
        for n in names:
            duckdb_extensions.import_extension(n, con=con)
    except Exception:  # pragma: no cover - environments with extensions.duckdb.org access
        for n in names:
            con.execute(f"INSTALL {n}")
    for n in names:
        con.execute(f"LOAD {n}")


def work_connection() -> duckdb.DuckDBPyConnection:
    ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(WORK_DB))
    con.execute(f"SET threads={max(1, (os.cpu_count() or 2))}")
    con.execute("SET preserve_insertion_order=false")
    return con


def attach_mysql(con: duckdb.DuckDBPyConnection, alias: str = "src"):
    load_extensions(con, "mysql_scanner")
    p = mysql_params("openmrs")
    user = os.environ.get("MYSQL_ETL_USER", p["user"])
    pwd = os.environ.get("MYSQL_ETL_PASSWORD", p["password"])
    con.execute(f"ATTACH 'host={p['host']} user={user} password={pwd} port={p['port']} database=openmrs' "
                f"AS {alias} (TYPE mysql, READ_ONLY)")


def run_sql_file(con, path: Path, **params):
    text = path.read_text()
    for k, v in params.items():
        text = text.replace("{{" + k + "}}", str(v))
    con.execute(text)


def run_sql_dir(con, sub: str, **params) -> list[str]:
    done = []
    for f in sorted((SQL_DIR / sub).glob("*.sql")):
        run_sql_file(con, f, **params)
        done.append(f.name)
    return done
