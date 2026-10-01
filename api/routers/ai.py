"""Ask the Data + AI insight cards (SPEC §15.2-15.3)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from ..deps import SERVE, APIError, Role, envelope, role
from ..llm.nl2sql import SEMANTIC, ask
from ..llm.provider import get_provider
from ..llm.summaries import insights

router = APIRouter()
VIEWS = ("overview", "geo", "trends", "warning", "quality", "models")


@router.post("/ask")
def ask_endpoint(body: dict = Body(...), r: Role = Depends(role)):
    q = (body.get("question") or "").strip()
    if not q or len(q) > 500:
        raise APIError(400, "INVALID_QUESTION", "question must be 1-500 characters")
    return envelope(ask(q, r.role, r.facility_id))


@router.get("/ask/suggestions")
def suggestions(r: Role = Depends(role)):
    return envelope(SEMANTIC["suggested_questions"][r.role], provider=get_provider().name)


@router.get("/insights")
def insights_endpoint(view: str = "overview", r: Role = Depends(role)):
    if view not in VIEWS:
        raise APIError(400, "INVALID_FILTER", f"view must be one of {list(VIEWS)}")
    return envelope(SERVE.cached(("insights", view), lambda: insights(view)), provider=get_provider().name)
