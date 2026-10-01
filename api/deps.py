"""Serve-DB connection manager (blue/green aware), role guards and response helpers (SPEC §14.1)."""
from __future__ import annotations

import datetime as dt
import json
import math
import threading
from typing import Any

import duckdb
from fastapi import Header, HTTPException

from shared.config import ANALYTICS_DIR


class APIError(HTTPException):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(status_code=status, detail={"code": code, "message": message, "details": details or {}})


class ServeDB:
    """Holds a read-only connection to the active serve_<colour>.duckdb; swaps when current.json changes."""

    def __init__(self):
        self._lock = threading.RLock()
        self._con: duckdb.DuckDBPyConnection | None = None
        self.current: dict | None = None
        self._cache: dict = {}

    def refresh(self) -> bool:
        try:
            cur = json.load(open(ANALYTICS_DIR / "current.json"))
        except (FileNotFoundError, json.JSONDecodeError):
            return False
        if self.current and cur.get("run_id") == self.current.get("run_id") and cur.get("active") == self.current.get("active"):
            return False
        path = ANALYTICS_DIR / f"serve_{cur['active']}.duckdb"
        new = duckdb.connect(str(path), read_only=True)
        with self._lock:
            old, self._con, self.current, self._cache = self._con, new, cur, {}
        if old is not None:
            old.close()
        return True

    @property
    def ready(self) -> bool:
        return self._con is not None

    def meta(self) -> dict:
        c = self.current or {}
        return {"run_id": c.get("run_id"), "sim_time": c.get("sim_time"), "published_at": c.get("published_at")}

    def rows(self, sql: str, params: list | None = None) -> list[dict]:
        if self._con is None:
            raise APIError(503, "NOT_READY", "No published analytics yet - run the pipeline")
        with self._lock:
            cur = self._con.cursor()
        try:
            r = cur.execute(sql, params or [])
            cols = [d[0] for d in r.description]
            return [{k: _clean(v) for k, v in zip(cols, row)} for row in r.fetchall()]
        finally:
            cur.close()

    def one(self, sql: str, params: list | None = None) -> dict | None:
        r = self.rows(sql, params)
        return r[0] if r else None

    def cached(self, key: tuple, fn):
        """Per-run_id cache (SPEC §14.1): cleared automatically on every publish."""
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        v = fn()
        with self._lock:
            self._cache[key] = v
        return v

    def has_table(self, name: str) -> bool:
        return bool(self.one("SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?", [name])["n"])

    def connection(self):
        with self._lock:
            return self._con.cursor() if self._con else None


def _clean(v: Any):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        try:
            return v.item()
        except Exception:
            return v
    return v


SERVE = ServeDB()


def envelope(data, **extra) -> dict:
    return {"meta": SERVE.meta(), "data": data, **extra}


class Role:
    def __init__(self, role: str, facility_id: int | None):
        self.role = role
        self.facility_id = facility_id


def role(x_role: str | None = Header(default="ministry"), x_facility_id: int | None = Header(default=None)) -> Role:
    r = (x_role or "ministry").lower()
    if r not in ("ministry", "doctor"):
        raise APIError(400, "INVALID_ROLE", "X-Role must be 'ministry' or 'doctor'")
    if r == "doctor" and x_facility_id is None:
        raise APIError(400, "FACILITY_REQUIRED", "Doctor requests need an X-Facility-Id header")
    return Role(r, x_facility_id)


def ministry(r: Role) -> Role:
    if r.role != "ministry":
        raise APIError(403, "FORBIDDEN", "This endpoint serves aggregate data to the ministry role")
    return r


def doctor(r: Role) -> Role:
    if r.role != "doctor":
        raise APIError(403, "FORBIDDEN", "Patient-level data is only available to the doctor role (SPEC §18)")
    return r


def parse_json(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return v
    return v
