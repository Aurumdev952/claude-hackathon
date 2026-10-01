"""Judge model for the DeepEval metrics: any OpenRouter model through the OpenAI-compatible API.

deepeval 4.2.7 ships an `OpenRouterModel`, but it sends `json_schema` with `strict: true` and falls back to free text
once; reasoning models routed through OpenRouter do not always honour strict schemas. This `DeepEvalBaseLLM` subclass
is what DeepEval documents for custom judges, made robust for schema-following:

  1. `response_format={"type": "json_object"}` plus the pydantic JSON Schema in the prompt,
  2. tolerant JSON extraction (code fences, prose around the object, trailing commas),
  3. `schema.model_validate(...)`; on failure the validation error is sent back and the call retried (3 attempts),
  4. transport errors / 429 / 5xx retried with exponential backoff, one concurrency limit for all metrics.

Configured from the environment:
  EVAL_JUDGE_MODEL       default deepseek/deepseek-v4-pro (must differ from AGENT_MODEL, the model under test)
  EVAL_JUDGE_REASONING   off | low | medium | high (default off): OpenRouter `reasoning` effort for the judge. "low" cost
                         about $2.7 for 300 judge calls on deepseek-v4-pro (2026-10-01), mostly reasoning tokens.
  EVAL_JUDGE_CONCURRENCY default 12 concurrent judge requests
  EVAL_JUDGE_TIMEOUT_S   default 180 per request
  OPENROUTER_API_KEY     required; OPENROUTER_BASE_URL optional (default https://openrouter.ai/api/v1)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from typing import Any, Optional

from deepeval.models import DeepEvalBaseLLM
from openai import APIStatusError, AsyncOpenAI, OpenAI
from pydantic import BaseModel, ValidationError

DEFAULT_JUDGE = "deepseek/deepseek-v4-pro"
SYSTEM = (
    "You are a meticulous, impartial evaluator of an AI assistant for a gastric-cancer surveillance programme. "
    "Follow the instructions exactly. When a JSON format is requested, reply with ONE valid JSON object and nothing else."
)


class JudgeUnavailable(RuntimeError):
    """The judge cannot be used at all (bad / exhausted key, no credit): abort instead of scoring every metric as failed."""


FATAL_STATUS = (401, 402, 403)


def openrouter_key_status(timeout_s: float = 10.0) -> dict:
    """GET /api/v1/key (free): {ok, limit, limit_remaining, usage, error}. Used as a preflight before any model call."""
    import httpx
    key = os.getenv("OPENROUTER_API_KEY") or ""
    if not key:
        return {"ok": False, "error": "OPENROUTER_API_KEY is not set"}
    base = (os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
    try:
        r = httpx.get(f"{base}/key", headers={"Authorization": f"Bearer {key}"}, timeout=timeout_s)
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"OpenRouter unreachable: {e.__class__.__name__}: {e}"}
    if r.status_code != 200:
        return {"ok": False, "error": f"OpenRouter key check HTTP {r.status_code}: {r.text[:200]}"}
    d = (r.json() or {}).get("data") or {}
    remaining = d.get("limit_remaining")
    out = {"ok": True, "limit": d.get("limit"), "limit_remaining": remaining, "usage": d.get("usage")}
    if remaining is not None and float(remaining) <= 0:
        out.update(ok=False, error=f"OpenRouter key limit exhausted (limit ${d.get('limit')}, remaining ${remaining})")
    return out


def judge_model_name() -> str:
    return os.getenv("EVAL_JUDGE_MODEL") or DEFAULT_JUDGE


def extract_json(text: str | None) -> Any:
    """First JSON object in `text` (tolerates ```json fences, prose and trailing commas)."""
    if not text:
        raise ValueError("empty response")
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
    start = t.find("{")
    if start < 0:
        raise ValueError("no JSON object in response")
    depth, in_str, esc = 0, False, False
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            esc = (not esc) and ch == "\\"
            if ch == '"' and not esc:
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blob = t[start:i + 1]
                try:
                    return json.loads(blob)
                except json.JSONDecodeError:
                    return json.loads(re.sub(r",\s*([\]}])", r"\1", blob))
    blob = t[start:] + "}" * max(depth, 0)
    return json.loads(re.sub(r",\s*([\]}])", r"\1", blob))


class OpenRouterJudge(DeepEvalBaseLLM):
    """DeepEval judge backed by an OpenRouter chat model with robust structured output."""

    def __init__(self, model: Optional[str] = None, *, temperature: float = 0.0, max_attempts: int = 3):
        self.model_id = model or judge_model_name()
        self.api_key = os.getenv("OPENROUTER_API_KEY") or ""
        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set (needed for the DeepEval judge)")
        self.base_url = (os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
        self.temperature = temperature
        self.max_attempts = max_attempts
        self.timeout_s = float(os.getenv("EVAL_JUDGE_TIMEOUT_S") or 180)
        self.concurrency = int(os.getenv("EVAL_JUDGE_CONCURRENCY") or 12)
        effort = (os.getenv("EVAL_JUDGE_REASONING") or "off").lower()
        self.extra_body: dict[str, Any] = {"usage": {"include": True}}
        if effort in ("off", "none", "false", "0"):
            self.extra_body["reasoning"] = {"enabled": False}
        elif effort in ("low", "medium", "high"):
            self.extra_body["reasoning"] = {"effort": effort}
        self.fatal: Optional[str] = None
        self._sems: dict[int, asyncio.Semaphore] = {}
        self._lock = threading.Lock()
        self.calls = 0
        self.failures = 0
        self.cost = 0.0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        super().__init__(self.model_id)

    # ------------------------------------------------------------------ DeepEvalBaseLLM contract
    def load_model(self, async_mode: bool = False):
        kw = dict(api_key=self.api_key, base_url=self.base_url, timeout=self.timeout_s, max_retries=0)
        return AsyncOpenAI(**kw) if async_mode else OpenAI(**kw)

    def get_model_name(self) -> str:
        return f"{self.model_id} (OpenRouter judge)"

    def generate(self, prompt: str, schema: Optional[type[BaseModel]] = None):
        client = self.load_model(async_mode=False)
        return self._loop_sync(client, prompt, schema)

    async def a_generate(self, prompt: str, schema: Optional[type[BaseModel]] = None):
        client = self.load_model(async_mode=True)
        sem = self._sem()
        async with sem:
            return await self._loop_async(client, prompt, schema)

    def supports_json_mode(self) -> bool:
        return True

    def supports_structured_outputs(self) -> bool:
        return False

    def supports_log_probs(self) -> bool:
        return False

    def supports_temperature(self) -> bool:
        return True

    # ------------------------------------------------------------------ internals
    def _sem(self) -> asyncio.Semaphore:
        loop_id = id(asyncio.get_running_loop())
        with self._lock:
            if loop_id not in self._sems:
                self._sems[loop_id] = asyncio.Semaphore(self.concurrency)
            return self._sems[loop_id]

    def _messages(self, prompt: str, schema: Optional[type[BaseModel]], feedback: list[str]) -> list[dict]:
        content = prompt
        if schema is not None:
            js = json.dumps(schema.model_json_schema(), separators=(",", ":"))
            content += (
                "\n\n---\nReturn ONLY one JSON object that validates against this JSON Schema "
                f"(no markdown, no commentary):\n{js}"
            )
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}]
        for fb in feedback:
            msgs.append({"role": "user", "content": fb})
        return msgs

    def _kwargs(self, schema) -> dict:
        kw: dict[str, Any] = dict(model=self.model_id, temperature=self.temperature, extra_body=self.extra_body)
        if schema is not None:
            kw["response_format"] = {"type": "json_object"}
        return kw

    def _account(self, completion) -> None:
        with self._lock:
            self.calls += 1
            u = getattr(completion, "usage", None)
            if u is not None:
                self.prompt_tokens += getattr(u, "prompt_tokens", 0) or 0
                self.completion_tokens += getattr(u, "completion_tokens", 0) or 0
                c = getattr(u, "cost", None)
                if c is not None:
                    try:
                        self.cost += float(c)
                    except (TypeError, ValueError):
                        pass

    def _parse(self, text: str | None, schema):
        if schema is None:
            return text or ""
        return schema.model_validate(extract_json(text))

    def _check_fatal(self, e: Optional[Exception] = None) -> None:
        if e is not None and isinstance(e, APIStatusError) and e.status_code in FATAL_STATUS:
            with self._lock:
                self.fatal = self.fatal or f"HTTP {e.status_code}: {str(e)[:300]}"
        if self.fatal:
            raise JudgeUnavailable(f"judge {self.model_id} unavailable: {self.fatal}")

    @staticmethod
    def _retryable(e: Exception) -> bool:
        if isinstance(e, APIStatusError):
            return e.status_code in (408, 409, 425, 429) or e.status_code >= 500
        return True  # timeouts, connection resets, empty choices

    async def _loop_async(self, client, prompt, schema):
        feedback: list[str] = []
        last: Exception | None = None
        for attempt in range(self.max_attempts + 2):
            self._check_fatal()
            try:
                completion = await client.chat.completions.create(
                    messages=self._messages(prompt, schema, feedback), **self._kwargs(schema))
                self._account(completion)
                text = completion.choices[0].message.content if completion.choices else None
            except Exception as e:  # transport-level
                self._check_fatal(e)
                last = e
                if not self._retryable(e) or attempt >= self.max_attempts + 1:
                    break
                await asyncio.sleep(min(2 ** attempt, 20))
                continue
            try:
                return self._parse(text, schema)
            except (ValidationError, ValueError, json.JSONDecodeError) as e:
                last = e
                if len(feedback) + 1 >= self.max_attempts:
                    break
                feedback = [f"Your previous reply was not valid: {str(e)[:600]}\nPrevious reply:\n{(text or '')[:1500]}\n"
                            "Reply again with ONLY the corrected JSON object."]
        with self._lock:
            self.failures += 1
        raise RuntimeError(f"judge {self.model_id} failed after retries: {last}")

    def _loop_sync(self, client, prompt, schema):
        feedback: list[str] = []
        last: Exception | None = None
        for attempt in range(self.max_attempts + 2):
            self._check_fatal()
            try:
                completion = client.chat.completions.create(
                    messages=self._messages(prompt, schema, feedback), **self._kwargs(schema))
                self._account(completion)
                text = completion.choices[0].message.content if completion.choices else None
            except Exception as e:
                self._check_fatal(e)
                last = e
                if not self._retryable(e) or attempt >= self.max_attempts + 1:
                    break
                time.sleep(min(2 ** attempt, 20))
                continue
            try:
                return self._parse(text, schema)
            except (ValidationError, ValueError, json.JSONDecodeError) as e:
                last = e
                if len(feedback) + 1 >= self.max_attempts:
                    break
                feedback = [f"Your previous reply was not valid: {str(e)[:600]}\nPrevious reply:\n{(text or '')[:1500]}\n"
                            "Reply again with ONLY the corrected JSON object."]
        with self._lock:
            self.failures += 1
        raise RuntimeError(f"judge {self.model_id} failed after retries: {last}")

    def usage(self) -> dict:
        return {"model": self.model_id, "fatal": self.fatal, "calls": self.calls, "failures": self.failures, "cost_usd": round(self.cost, 4),
                "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens}
