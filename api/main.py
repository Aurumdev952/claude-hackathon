"""Early Signals API (SPEC §14). `uvicorn api.main:app --port 8000`"""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from shared.config import SIM_STATE_DIR

from .deps import SERVE
from .routers import admin, ai, care, epi, forecast, meta, models, patient_app, patients
from .ws import HUB, endpoint

PREFIX = "/api/v1"


def _drain_care_outbox() -> list[dict]:
    """Queued care events (care.sqlite outbox, written by the API and the simulator process). v3 contract §4.3."""
    try:
        from care.store import get_store
        return get_store().drain()
    except Exception as e:  # noqa: BLE001
        print(f"care outbox error: {e}")
        return []


async def _watch():
    """Poll current.json every 2 s (SPEC §10.2); on change reopen the serve file and broadcast `refresh`.
    Also drains the care outbox and dispatches targeted care events (v3)."""
    last_tick = None
    seen_alerts: set[str] = set()
    first = True
    while True:
        try:
            if SERVE.refresh():
                c = SERVE.current
                await HUB.broadcast({"type": "refresh", "run_id": c.get("run_id"), "sim_time": c.get("sim_time"),
                                     "changed": c.get("changed", [])})
                if SERVE.has_table("pt_alerts"):
                    rows = SERVE.rows("SELECT alert_id, facility_id, severity FROM pt_alerts WHERE severity = 'HIGH'")
                    if not first:
                        for a in rows:
                            if a["alert_id"] not in seen_alerts:
                                await HUB.broadcast({"type": "alert_new", **a})
                    seen_alerts = {a["alert_id"] for a in rows}
                first = False
            try:
                tick = json.load(open(SIM_STATE_DIR / "last_tick.json"))
                if tick != last_tick and last_tick is not None:
                    await HUB.broadcast({"type": "sim_tick", **tick})
                last_tick = tick
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            for msg in await asyncio.to_thread(_drain_care_outbox):
                await HUB.dispatch(msg)
        except Exception as e:  # never let the watcher die
            print(f"watcher error: {e}")
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    SERVE.refresh()
    task = asyncio.create_task(_watch())
    admin.resume_auto_on_startup()   # v3 in-API auto clock (control.json api_auto), see api/routers/admin.py
    yield
    task.cancel()


app = FastAPI(title="Early Signals API", version="1.1.0", openapi_url=f"{PREFIX}/openapi.json", docs_url=f"{PREFIX}/docs",
              lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("API_CORS_ORIGINS", "http://localhost:5173").split(","),
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    d = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail), "details": {}}
    return JSONResponse(status_code=exc.status_code, content={"error": d})


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST", "message": "Request validation failed",
                                                            "details": {"errors": json.loads(json.dumps(exc.errors(), default=str))}}})


for r in (meta.router, epi.router, models.router, patients.router, ai.router, admin.router,
          care.router, patient_app.router, forecast.router):  # v3 routers (docs/contracts/v3-loop.md)
    app.include_router(r, prefix=PREFIX)
app.add_api_websocket_route(f"{PREFIX}/ws", endpoint)
