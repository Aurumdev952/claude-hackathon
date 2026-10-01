"""Runs the whole evaluation once: agent calls (4 concurrent, deduplicated) -> DeepEval metrics (concurrent judge calls)
-> results + reports. Used by test_agent_eval.py; also runnable directly:

    PYTHONPATH=. uv run --extra eval python -m evals.agent.runner

Environment: AGENT_URL, EVAL_JUDGE_MODEL, EVAL_AGENT_CONCURRENCY (4), EVAL_JUDGE_CONCURRENCY (12), EVAL_ONLY (comma
separated ids / prefixes), EVAL_ROLE (ministry|doctor), EVAL_REUSE_RESPONSES (path of an earlier results json: re-judge
its agent responses without calling the agent).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from importlib.metadata import version
from pathlib import Path

from . import client
from .judge import OpenRouterJudge, judge_model_name
from .metrics import evaluate_golden, load_goldens
from .report import build_results, now_stamp, write_reports


def _reuse(goldens: list[dict], path: str) -> dict[str, client.AgentResponse]:
    prev = json.loads(Path(path).read_text())
    by_id = {r["id"]: r for r in prev["goldens"]}
    out = {}
    missing = []
    for g in goldens:
        r = by_id.get(g["id"])
        if r and r["input"] == g["input"]:
            out[g["id"]] = client.AgentResponse.from_json(r["response"])
        else:
            missing.append(g)
    if missing:
        out.update(client.ask_many(missing, int(os.getenv("EVAL_AGENT_CONCURRENCY") or 4)))
    return out


PROGRESS = Path(__file__).resolve().parent / "results" / "progress.log"


def _progress(msg: str) -> None:
    """Live progress (pytest captures stdout): tail -f evals/agent/results/progress.log"""
    try:
        PROGRESS.parent.mkdir(parents=True, exist_ok=True)
        with PROGRESS.open("a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except OSError:
        pass


async def _judge_all(goldens, responses, judge):
    done = 0

    async def one(g):
        nonlocal done
        checks = await evaluate_golden(g, responses[g["id"]], judge)
        done += 1
        failed = [f"{c.group}:{c.name}" for c in checks if c.applicable and c.passed is False]
        _progress(f"judged {done}/{len(goldens)} {g['id']} failed={failed or '-'} judge_calls={judge.calls}")
        return g["id"], checks
    return dict(await asyncio.gather(*[one(g) for g in goldens]))


def run_eval(write: bool = True) -> dict:
    t0 = time.time()
    goldens = load_goldens()
    if not goldens:
        raise RuntimeError("no goldens selected (check EVAL_ONLY / EVAL_ROLE)")
    health = client.health() or {}
    agent_model = (health.get("model") or {}).get("model") or os.getenv("AGENT_MODEL")
    judge_name = judge_model_name()
    if agent_model and judge_name.split(":")[0] == agent_model:
        raise RuntimeError(f"EVAL_JUDGE_MODEL ({judge_name}) must differ from the model under test ({agent_model})")

    PROGRESS.unlink(missing_ok=True)
    _progress(f"start: {len(goldens)} goldens, agent {client.agent_url()} ({agent_model}), judge {judge_name}")
    reuse = os.getenv("EVAL_REUSE_RESPONSES")
    responses = _reuse(goldens, reuse) if reuse else client.ask_many(goldens, int(os.getenv("EVAL_AGENT_CONCURRENCY") or 4))
    t_agent = time.time() - t0
    _progress(f"agent phase done in {t_agent:.0f}s; failed calls: {[k for k, r in responses.items() if not r.ok] or '-'}")

    judge = OpenRouterJudge()
    checks = asyncio.run(_judge_all(goldens, responses, judge))
    t_judge = time.time() - t0 - t_agent

    meta = {
        "timestamp": now_stamp(),
        "agent_url": client.agent_url(),
        "agent_model": agent_model,
        "serve_run_id": (health.get("serve") or {}).get("run_id"),
        "sim_time": (health.get("serve") or {}).get("sim_time"),
        "judge_model": judge_name,
        "judge_reasoning": os.getenv("EVAL_JUDGE_REASONING") or "low",
        "judge_usage": judge.usage(),
        "deepeval_version": version("deepeval"),
        "reused_responses": reuse,
        "filters": {"EVAL_ONLY": os.getenv("EVAL_ONLY"), "EVAL_ROLE": os.getenv("EVAL_ROLE")},
        "agent_phase_s": round(t_agent, 1),
        "judge_phase_s": round(t_judge, 1),
        "duration_s": round(time.time() - t0, 1),
        "mean_agent_latency_ms": round(sum(r.latency_ms for r in responses.values()) / max(len(responses), 1)),
    }
    res = build_results(goldens, responses, checks, meta)
    if write:
        res["paths"] = {k: str(v) for k, v in write_reports(res).items()}
    return res


if __name__ == "__main__":
    from .report import render_markdown
    out = run_eval()
    print(render_markdown(out))
    raise SystemExit(0 if out["gate"]["ready"] else 1)
