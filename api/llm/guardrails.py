"""LLM safety (SPEC §15.1-15.2, §18): read-only single-SELECT SQL over allow-listed tables, row limits, number checks,
and de-identification of payloads before they reach a remote provider."""
from __future__ import annotations

import re

import sqlglot
from sqlglot import exp

FORBIDDEN_FUNCS = {"read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto", "read_text", "read_blob",
                   "glob", "sniff_csv", "query", "query_table", "getenv", "parquet_scan", "csv_scan"}
MINISTRY_TABLES = None  # resolved at runtime: every mart_* table
DOCTOR_EXTRA = {"pt_patient", "pt_risk", "pt_alerts", "pt_patient_facility"}
PII_KEYS = {"given_name", "family_name", "name", "display_id", "patient_id", "birthdate", "phone", "national_id"}


class UnsafeSQL(ValueError):
    pass


def validate_sql(sql: str, role: str, allowed_tables: set[str], max_rows: int = 1000) -> str:
    sql = sql.strip().rstrip(";").strip()
    sql = re.sub(r"^```(?:sql)?|```$", "", sql, flags=re.I).strip()
    try:
        stmts = sqlglot.parse(sql, read="duckdb")
    except sqlglot.errors.ParseError as e:
        raise UnsafeSQL(f"could not parse SQL: {e}") from e
    if len(stmts) != 1 or stmts[0] is None:
        raise UnsafeSQL("exactly one statement is allowed")
    tree = stmts[0]
    if not isinstance(tree, (exp.Select, exp.Union, exp.Intersect, exp.Except)) and not tree.find(exp.Select):
        raise UnsafeSQL("only SELECT statements are allowed")
    for bad in (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create, exp.Alter, exp.Command, exp.Copy, exp.Attach,
                exp.Pragma, exp.Set, exp.Use):
        if tree.find(bad):
            raise UnsafeSQL(f"{bad.__name__.upper()} is not allowed")
    for f in tree.find_all(exp.Anonymous, exp.Func):
        n = (f.name or f.sql_name() or "").lower()
        if n in FORBIDDEN_FUNCS or n.startswith("read_"):
            raise UnsafeSQL(f"function {n} is not allowed")
    lowered = tree.sql(dialect="duckdb").lower()
    for fn in FORBIDDEN_FUNCS:  # safety net for table functions in FROM (parsed as Table nodes)
        if re.search(rf"\b{fn}\s*\(", lowered):
            raise UnsafeSQL(f"function {fn} is not allowed")
    if re.search(r"\bread_\w+\s*\(", lowered) or re.search(r"'[^']*\.(csv|parquet|json|duckdb|db)'", lowered):
        raise UnsafeSQL("file access is not allowed")
    ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    for t in tree.find_all(exp.Table):
        if isinstance(t.this, (exp.Func, exp.Anonymous)):
            raise UnsafeSQL("table functions are not allowed")
        name = t.name.lower()
        if not name or name in ctes:
            continue
        if t.args.get("db") or t.args.get("catalog"):
            raise UnsafeSQL("schema-qualified tables are not allowed")
        if name not in allowed_tables:
            raise UnsafeSQL(f"table {name} is not available to the {role} role")
    if not tree.args.get("limit") and isinstance(tree, exp.Select):
        tree = tree.limit(max_rows)
    return tree.sql(dialect="duckdb")


NUM_RE = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)*(?:\.\d+)?")


def numbers_in(text: str) -> list[float]:
    out = []
    for m in NUM_RE.findall(text):
        try:
            out.append(float(m.replace(",", "")))
        except ValueError:
            pass
    return out


def numbers_supported(answer: str, allowed: list[float], tol: float = 0.051) -> bool:
    """Every number in the answer must appear in the result (± rounding) - SPEC §15.2 step 9.
    Small integers (<= 31: counts like 'top 5', months, days) and 4-digit years are always allowed."""
    pool = [float(a) for a in allowed if isinstance(a, (int, float))]
    for n in numbers_in(answer):
        if abs(n) <= 31 or (1990 <= n <= 2035 and n == int(n)):
            continue
        if not any(abs(n - a) <= max(tol, abs(a) * 0.005) or abs(n - round(a, 0)) < 0.51 and abs(a) > 20 or
                   abs(n - a * 100) <= 0.51 for a in pool):
            return False
    return True


def deidentify(obj):
    """Strip identifying fields from any payload bound for a remote provider."""
    if isinstance(obj, dict):
        return {k: deidentify(v) for k, v in obj.items() if k not in PII_KEYS}
    if isinstance(obj, list):
        return [deidentify(x) for x in obj]
    return obj
