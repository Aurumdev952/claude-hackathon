"""HTTP client for the agent under test: POST {AGENT_URL}/agent/chat/complete (non-streaming, not persisted).

Returns an `AgentResponse` with the answer, the model-safe tool calls (what the remote model saw), the full widget
outputs from the UI message parts (for the widget gate) and the retrieval context (tool outputs as JSON strings).
"""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Optional

import httpx

DEFAULT_URL = "http://localhost:8787"
WIDGET_TOOLS = {"make_chart", "make_patient_widget", "run_python"}
# Text the agent streams when the model call itself failed (agent/src/agents/run.ts onError): not an answer.
AGENT_ERROR_RE = re.compile(r"^\s*(Agent error:|The language model rejected the request)|Key limit exceeded|insufficient credits", re.I)


def agent_url() -> str:
    return (os.getenv("AGENT_URL") or DEFAULT_URL).rstrip("/")


@dataclass
class AgentResponse:
    golden_id: str
    role: str
    facility_id: Optional[int]
    question: str
    ok: bool
    status: int
    error: Optional[str] = None
    answer: str = ""
    tool_calls: list[dict] = field(default_factory=list)       # model-safe: name, state, input, output, error
    widgets: list[dict] = field(default_factory=list)          # full UI outputs of widget tools (chart / patient / artifact)
    widget_errors: list[dict] = field(default_factory=list)    # widget tools that failed (output ok:false / output-error)
    retrieval_context: list[str] = field(default_factory=list)
    validated_numbers: Optional[bool] = None
    unsupported_numbers: list[float] = field(default_factory=list)
    names_in_ui: list[str] = field(default_factory=list)      # patient names present in UI-only outputs (never sent to judge)
    model: Optional[str] = None
    latency_ms: int = 0

    @property
    def tools_called(self) -> list[str]:
        return [c["name"] for c in self.tool_calls]

    def to_json(self) -> dict:
        """Persistable view: UI-only patient names and contact fields are redacted (results / fixtures stay name-free)."""
        d = asdict(self)
        d.pop("names_in_ui", None)
        d["widgets"] = redact(d["widgets"], set(self.names_in_ui))
        return d

    @classmethod
    def from_json(cls, d: dict) -> "AgentResponse":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


def _headers(role: str, facility_id: Optional[int]) -> dict:
    h = {"Content-Type": "application/json", "X-Role": role}
    if facility_id is not None:
        h["X-Facility-Id"] = str(facility_id)
    return h


PATIENT_KEYS = {"display_id", "patient_id"}
NAME_KEYS = {"given_name", "family_name", "patient_name", "full_name"}
CONTACT_KEYS = {"birthdate", "phone", "national_id", "address"}
REDACTED = "[redacted]"


def _is_patient_obj(o: dict) -> bool:
    return o.get("kind") == "patient" or bool(PATIENT_KEYS & o.keys())


def redact(o: Any, names: set[str] | frozenset = frozenset()) -> Any:
    """Structural + string redaction of patient names in UI payloads (patient card `name`, `name` next to a patient
    key, given / family names, contact fields, and any string containing a known name)."""
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in CONTACT_KEYS:
                continue
            if isinstance(v, str) and (k in NAME_KEYS or (k == "name" and _is_patient_obj(o))):
                out[k] = REDACTED
            else:
                out[k] = redact(v, names)
        return out
    if isinstance(o, list):
        return [redact(v, names) for v in o]
    if isinstance(o, str) and names:
        for n in names:
            if n and n in o:
                o = o.replace(n, REDACTED)
    return o


def _collect_names(o: Any, out: set[str]) -> None:
    """Patient names in a UI payload: `name` of a patient card or of a row with a patient key, given / family names."""
    if isinstance(o, dict):
        keys = list(NAME_KEYS) + (["name"] if _is_patient_obj(o) else [])
        for k in keys:
            v = o.get(k)
            if isinstance(v, str) and v.strip():
                out.add(v.strip())
        for v in o.values():
            _collect_names(v, out)
    elif isinstance(o, list):
        for v in o:
            _collect_names(v, out)


def parse_response(golden_id: str, role: str, facility_id: Optional[int], question: str, body: dict, status: int,
                   latency_ms: int) -> AgentResponse:
    d = body.get("data") or {}
    message = d.get("message") or {}
    widgets: list[dict] = []
    widget_errors: list[dict] = []
    names: set[str] = set()
    for p in message.get("parts") or []:
        t = p.get("type", "")
        if not t.startswith("tool-"):
            continue
        name = t[5:]
        if name not in WIDGET_TOOLS:
            continue
        out = p.get("output")
        if p.get("state") == "output-error":
            widget_errors.append({"tool": name, "error": p.get("errorText")})
        elif isinstance(out, dict) and out.get("kind") in ("chart", "patient", "artifact"):
            widgets.append({"tool": name, "output": out})
            _collect_names(out, names)
        elif isinstance(out, dict):
            widget_errors.append({"tool": name, "error": out.get("error") or "no widget returned", "output": out})
    answer = d.get("answer") or ""
    agent_error = AGENT_ERROR_RE.search(answer) if not answer or len(answer) < 600 else None
    return AgentResponse(
        golden_id=golden_id, role=role, facility_id=facility_id, question=question, ok=not agent_error and bool(answer),
        error=(f"agent returned an error instead of an answer: {answer[:300]}" if agent_error else
               None if answer else "empty answer"),
        status=status,
        answer=answer,
        tool_calls=d.get("tool_calls") or [],
        widgets=widgets, widget_errors=widget_errors,
        retrieval_context=d.get("retrieval_context") or [],
        validated_numbers=d.get("validated_numbers"),
        unsupported_numbers=d.get("unsupported_numbers") or [],
        names_in_ui=sorted(names),
        model=(d.get("metadata") or {}).get("model"),
        latency_ms=d.get("latency_ms") or latency_ms,
    )


def ask(question: str, role: str = "ministry", facility_id: Optional[int] = None, golden_id: str = "adhoc",
        timeout_s: float = 300.0, retries: int = 1) -> AgentResponse:
    """One non-persisted agent turn. Transport errors and 5xx are retried once."""
    url = f"{agent_url()}/agent/chat/complete"
    last_err = None
    for attempt in range(retries + 1):
        t0 = time.time()
        try:
            r = httpx.post(url, headers=_headers(role, facility_id), json={"question": question, "persist": False},
                           timeout=timeout_s)
            ms = int((time.time() - t0) * 1000)
            if r.status_code >= 500 and attempt < retries:
                last_err = f"HTTP {r.status_code}: {r.text[:300]}"
                continue
            if r.status_code != 200:
                return AgentResponse(golden_id, role, facility_id, question, ok=False, status=r.status_code,
                                     error=f"HTTP {r.status_code}: {r.text[:500]}", latency_ms=ms)
            return parse_response(golden_id, role, facility_id, question, r.json(), r.status_code, ms)
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            last_err = f"{e.__class__.__name__}: {e}"
            time.sleep(2)
    return AgentResponse(golden_id, role, facility_id, question, ok=False, status=0, error=last_err)


def ask_many(goldens: Iterable[dict], concurrency: int = 4) -> dict[str, AgentResponse]:
    """Runs the goldens against the agent with modest parallelism; identical (role, facility, input) are asked once."""
    goldens = list(goldens)
    cache: dict[tuple, AgentResponse] = {}
    keys = {}
    for g in goldens:
        keys[g["id"]] = (g["role"], g.get("facility_id"), g["input"])
    unique = {}
    for g in goldens:
        unique.setdefault(keys[g["id"]], g)

    def run(item):
        key, g = item
        return key, ask(g["input"], g["role"], g.get("facility_id"), golden_id=g["id"])

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as ex:
        for key, resp in ex.map(run, unique.items()):
            cache[key] = resp
    out = {}
    for g in goldens:
        r = cache[keys[g["id"]]]
        out[g["id"]] = r if r.golden_id == g["id"] else AgentResponse(**{**asdict(r), "golden_id": g["id"]})
    return out


def health(timeout_s: float = 5.0) -> Optional[dict]:
    try:
        r = httpx.get(f"{agent_url()}/agent/health", timeout=timeout_s)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, json.JSONDecodeError):
        return None
