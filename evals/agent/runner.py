"""Runs the whole evaluation once: preflight -> agent calls (4 concurrent, deduplicated) -> DeepEval metrics (concurrent
judge calls) -> results + reports. Used by test_agent_eval.py; also runnable directly:

    PYTHONPATH=. uv run --extra eval python -m evals.agent.runner              # live run, exit 1 unless READY
    EVAL_OFFLINE=1 PYTHONPATH=. uv run --extra eval python -m evals.agent.runner   # replay fixtures, deterministic only
    PYTHONPATH=. uv run --extra eval python -m evals.agent.runner --rescore evals/agent/results/latest.json
        # re-run the deterministic checks of a results file (keeps its recorded DeepEval scores), rewrite the reports

Environment: AGENT_URL, EVAL_JUDGE_MODEL, EVAL_AGENT_CONCURRENCY (4), EVAL_JUDGE_CONCURRENCY (12), EVAL_ONLY (comma
separated ids / prefixes), EVAL_ROLE (ministry|doctor), EVAL_REUSE_RESPONSES (path of an earlier results json or a
fixtures file: re-judge its agent responses without calling the agent), EVAL_OFFLINE=1 (+ EVAL_FIXTURES, default
fixtures/responses.json): no agent, no judge.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from importlib.metadata import version
from pathlib import Path

from . import client
from .judge import judge_key_status, judge_model_name, judge_provider, make_judge
from .metrics import Check, deterministic_checks, evaluate_golden, load_goldens
from .report import build_results, now_stamp, write_reports

HERE = Path(__file__).resolve().parent
PROGRESS = HERE / "results" / "progress.log"
DEFAULT_FIXTURES = HERE / "fixtures" / "responses.json"


class EvalAborted(RuntimeError):
    """The run cannot produce a verdict (agent or judge unavailable). Never a silent pass."""


def offline() -> bool:
    return (os.getenv("EVAL_OFFLINE") or "").lower() in ("1", "true", "yes")


def _progress(msg: str) -> None:
    """Live progress (pytest captures stdout): tail -f evals/agent/results/progress.log"""
    try:
        PROGRESS.parent.mkdir(parents=True, exist_ok=True)
        with PROGRESS.open("a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except OSError:
        pass


def load_recorded(path: str | Path) -> dict[str, dict]:
    """Agent responses by golden id from a results json ({goldens:[{id, input, response}]}) or a fixtures file
    ({responses: {id: response}})."""
    d = json.loads(Path(path).read_text())
    if "responses" in d:
        return d["responses"]
    return {r["id"]: {**r["response"], "_input": r["input"]} for r in d["goldens"]}


def _reuse(goldens: list[dict], path: str, ask_missing: bool = True) -> dict[str, client.AgentResponse]:
    rec = load_recorded(path)
    out, missing = {}, []
    for g in goldens:
        r = rec.get(g["id"])
        if r and r.get("question", r.get("_input")) == g["input"]:
            out[g["id"]] = client.AgentResponse.from_json(r)
        else:
            missing.append(g)
    if missing and ask_missing:
        out.update(client.ask_many(missing, int(os.getenv("EVAL_AGENT_CONCURRENCY") or 4)))
    elif missing:
        for g in missing:
            out[g["id"]] = client.AgentResponse(g["id"], g["role"], g.get("facility_id"), g["input"], ok=False, status=0,
                                                error=f"no recorded response in {path} (input changed or new golden)")
    return out


async def _judge_all(goldens, responses, judge):
    done = 0

    async def one(g):
        nonlocal done
        checks = await evaluate_golden(g, responses[g["id"]], judge)
        done += 1
        failed = [f"{c.group}:{c.name}" for c in checks if c.applicable and c.passed is False]
        calls = judge.calls if judge else 0
        _progress(f"judged {done}/{len(goldens)} {g['id']} failed={failed or '-'} judge_calls={calls}")
        return g["id"], checks
    return dict(await asyncio.gather(*[one(g) for g in goldens]))


def preflight(need_agent: bool) -> tuple[dict, dict]:
    """Agent health + the judge key (OpenRouter credit or Anthropic key/model); raises EvalAborted with a clear reason."""
    problems = []
    health = client.health() if need_agent else {}
    if need_agent:
        if health is None:
            problems.append(f"agent not reachable at {client.agent_url()} (start it: make agent-dev)")
        elif not health.get("model_configured", True):
            problems.append("agent has no model configured (API key for AGENT_PROVIDER / AGENT_MODEL)")
    key = judge_key_status()
    if not key.get("ok"):
        problems.append(f"{key.get('error')} - the judge cannot be called")
    if problems:
        raise EvalAborted("; ".join(problems))
    return health or {}, key


def run_eval(write: bool = True) -> dict:
    t0 = time.time()
    goldens = load_goldens()
    if not goldens:
        raise RuntimeError("no goldens selected (check EVAL_ONLY / EVAL_ROLE)")
    PROGRESS.unlink(missing_ok=True)
    is_offline = offline()
    reuse = os.getenv("EVAL_REUSE_RESPONSES")

    if is_offline:
        fixtures = os.getenv("EVAL_FIXTURES") or str(DEFAULT_FIXTURES)
        health, key, agent_model = {}, {}, None
        _progress(f"offline replay of {fixtures}: {len(goldens)} goldens, deterministic checks only")
        responses = _reuse(goldens, fixtures, ask_missing=False)
        fx_meta = json.loads(Path(fixtures).read_text()).get("meta", {})
        agent_model = fx_meta.get("agent_model")
    else:
        health, key = preflight(need_agent=not reuse)
        agent_model = (health.get("model") or {}).get("model") or os.getenv("AGENT_MODEL")
        judge_name = judge_model_name()
        if agent_model and judge_name.split(":")[0] == agent_model:
            raise EvalAborted(f"EVAL_JUDGE_MODEL ({judge_name}) must differ from the model under test ({agent_model})")
        _progress(f"start: {len(goldens)} goldens, agent {client.agent_url()} ({agent_model}), judge {judge_name}, "
                  f"key remaining {key.get('limit_remaining')}")
        responses = _reuse(goldens, reuse) if reuse else client.ask_many(goldens, int(os.getenv("EVAL_AGENT_CONCURRENCY") or 4))
    t_agent = time.time() - t0
    bad = [k for k, r in responses.items() if not r.ok]
    _progress(f"agent phase done in {t_agent:.0f}s; failed calls: {bad or '-'}")

    judge = None if is_offline else make_judge()
    checks = asyncio.run(_judge_all(goldens, responses, judge))
    t_judge = time.time() - t0 - t_agent

    aborted = None
    if judge is not None and judge.fatal:
        aborted = f"judge unavailable mid-run ({judge.fatal}); results are partial"
    elif not is_offline and len(bad) == len(goldens):
        aborted = f"every agent call failed ({responses[bad[0]].error})"

    meta = {
        "timestamp": now_stamp(),
        "mode": "offline" if is_offline else "live",
        "aborted": aborted,
        "agent_url": None if is_offline else client.agent_url(),
        "agent_model": agent_model,
        "serve_run_id": (health.get("serve") or {}).get("run_id"),
        "sim_time": (health.get("serve") or {}).get("sim_time"),
        "judge_model": None if is_offline else judge_model_name(),
        "judge_provider": None if is_offline else judge_provider(),
        "judge_reasoning": None if is_offline else (os.getenv("EVAL_JUDGE_EFFORT") or "medium") if judge_provider() == "anthropic"
        else (os.getenv("EVAL_JUDGE_REASONING") or "off"),
        "judge_usage": judge.usage() if judge else {},
        "openrouter_key": {k: key.get(k) for k in ("limit", "limit_remaining", "usage")} if key else {},
        "deepeval_version": version("deepeval"),
        "reused_responses": os.getenv("EVAL_FIXTURES") or str(DEFAULT_FIXTURES) if is_offline else reuse,
        "filters": {"EVAL_ONLY": os.getenv("EVAL_ONLY"), "EVAL_ROLE": os.getenv("EVAL_ROLE")},
        "agent_phase_s": round(t_agent, 1),
        "judge_phase_s": round(t_judge, 1),
        "duration_s": round(time.time() - t0, 1),
        "mean_agent_latency_ms": round(sum(r.latency_ms for r in responses.values()) / max(len(responses), 1)),
    }
    res = build_results(goldens, responses, checks, meta)
    if write:
        res["paths"] = {k: str(v) for k, v in write_reports(res).items()}
    _progress(f"done: {'ABORTED ' + aborted if aborted else ('READY' if res['gate']['ready'] else 'NOT READY')}")
    return res


def rescore(path: str | Path, partial: str | None = None, write: bool = True) -> dict:
    """Re-run the deterministic checks on a results file with the current code; DeepEval results are kept as recorded."""
    prev = json.loads(Path(path).read_text())
    goldens = {g["id"]: g for g in load_goldens()}
    rows = [r for r in prev["goldens"] if r["id"] in goldens]
    responses, checks = {}, {}
    for r in rows:
        g = goldens[r["id"]]
        resp = client.AgentResponse.from_json(r["response"])
        responses[g["id"]] = resp
        if not resp.ok:
            checks[g["id"]] = [Check(**c) for c in r["checks"]]
            continue
        kept = [Check(**c) for c in r["checks"] if c["kind"] == "deepeval"]
        checks[g["id"]] = deterministic_checks(g, resp) + kept
    meta = {**prev["meta"], "rescored_at": now_stamp(), "rescored_from": str(path)}
    if partial:
        meta["aborted"] = partial
    res = build_results([goldens[r["id"]] for r in rows], responses, checks, meta)
    if write:
        res["paths"] = {k: str(v) for k, v in write_reports(res).items()}
    return res


if __name__ == "__main__":
    from .report import render_markdown
    if len(sys.argv) > 2 and sys.argv[1] == "--rescore":
        note = sys.argv[3] if len(sys.argv) > 3 else None
        out = rescore(sys.argv[2], note)
    else:
        try:
            out = run_eval()
        except EvalAborted as e:
            print(f"EVAL ABORTED: {e}", file=sys.stderr)
            raise SystemExit(2)
    print(render_markdown(out))
    raise SystemExit(0 if out["gate"]["ready"] else 1)
