"""Ask the Data + AI insight cards (SPEC §15.2-15.3)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from ..deps import SERVE, APIError, Role, envelope, role
from ..llm.nl2sql import SEMANTIC, ask
from ..llm.provider import get_provider
from ..llm.summaries import insights

router = APIRouter()
VIEWS = ("overview", "geo", "trends", "warning", "quality", "models")


def staff(r: Role = Depends(role)) -> Role:
    """Ask the Data and the insight cards serve the ministry and doctors. The patient app has no analytics access, so the
    patient role gets a clean 403 here instead of reaching the doctor/ministry code paths (which have no patient branch)."""
    if r.role not in ("ministry", "doctor"):
        raise APIError(403, "FORBIDDEN", "Ask the Data is available to the ministry and doctor roles only")
    return r


@router.post("/ask")
def ask_endpoint(body: dict = Body(...), r: Role = Depends(staff)):
    q = (body.get("question") or "").strip()
    if not q or len(q) > 500:
        raise APIError(400, "INVALID_QUESTION", "question must be 1-500 characters")
    return envelope(ask(q, r.role, r.facility_id))


@router.get("/ask/suggestions")
def suggestions(r: Role = Depends(staff)):
    return envelope(SEMANTIC["suggested_questions"][r.role], provider=get_provider().name)


@router.get("/insights")
def insights_endpoint(view: str = "overview", r: Role = Depends(staff)):
    if view not in VIEWS:
        raise APIError(400, "INVALID_FILTER", f"view must be one of {list(VIEWS)}")
    return envelope(SERVE.cached(("insights", view), lambda: insights(view)), provider=get_provider().name)
