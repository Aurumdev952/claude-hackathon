"""Judge model for the DeepEval metrics: Claude through the Anthropic SDK, or any OpenRouter model.

EVAL_JUDGE_PROVIDER=anthropic selects `AnthropicJudge` (default model claude-opus-5-5, key in ANTHROPIC_API_KEY): structured
output through `messages.parse(output_format=<pydantic schema>)`, effort from EVAL_JUDGE_EFFORT (default medium; Opus 5.5
always thinks, so there is no off switch and no temperature), refusal fallback `fallbacks="default"`, and the same
validation-feedback retries and fatal-key abort as below. The rest of this docstring describes `OpenRouterJudge`.

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
DEFAULT_ANTHROPIC_JUDGE = "claude-opus-5-5"
# $ per million input / output tokens (Anthropic list prices, 2026-09); unknown models are not costed
ANTHROPIC_PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-fable-5-1": (10.0, 50.0)}
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


def judge_provider() -> str:
    return (os.getenv("EVAL_JUDGE_PROVIDER") or "openrouter").lower()


def judge_model_name() -> str:
    default = DEFAULT_ANTHROPIC_JUDGE if judge_provider() == "anthropic" else DEFAULT_JUDGE
    return os.getenv("EVAL_JUDGE_MODEL") or default


def make_judge() -> DeepEvalBaseLLM:
    return AnthropicJudge() if judge_provider() == "anthropic" else OpenRouterJudge()


def anthropic_key_status(timeout_s: float = 10.0) -> dict:
    """GET /v1/models/{judge model} (free): checks the key and that the judge model exists, before any paid call."""
    import anthropic
    if not os.getenv("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "ANTHROPIC_API_KEY is not set"}
    try:
        m = anthropic.Anthropic(timeout=timeout_s, max_retries=1).models.retrieve(judge_model_name())
    except anthropic.AuthenticationError as e:
        return {"ok": False, "error": f"Anthropic key rejected: {e.message}"}
    except anthropic.NotFoundError:
        return {"ok": False, "error": f"Anthropic model {judge_model_name()} not found"}
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"Anthropic key check HTTP {e.status_code}: {e.message}"}
    except anthropic.APIConnectionError as e:
        return {"ok": False, "error": f"Anthropic unreachable: {e}"}
    return {"ok": True, "model": m.id}


def judge_key_status() -> dict:
    return anthropic_key_status() if judge_provider() == "anthropic" else openrouter_key_status()


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


class AnthropicJudge(DeepEvalBaseLLM):
    """DeepEval judge backed by Claude (Anthropic SDK): native structured output, validation feedback, fatal-key abort."""

    def __init__(self, model: Optional[str] = None, *, max_attempts: int = 3):
        import anthropic
        self._anthropic = anthropic
        self.model_id = model or judge_model_name()
        if not os.getenv("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY is not set (needed for the DeepEval judge)")
        self.max_attempts = max_attempts
        self.timeout_s = float(os.getenv("EVAL_JUDGE_TIMEOUT_S") or 180)
        self.concurrency = int(os.getenv("EVAL_JUDGE_CONCURRENCY") or 12)
        self.effort = (os.getenv("EVAL_JUDGE_EFFORT") or "medium").lower()
        self.max_tokens = int(os.getenv("EVAL_JUDGE_MAX_TOKENS") or 16000)
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
        a = self._anthropic
        kw = dict(timeout=self.timeout_s, max_retries=4)  # the SDK retries 408/409/429/5xx and connection errors
        return a.AsyncAnthropic(**kw) if async_mode else a.Anthropic(**kw)

    def get_model_name(self) -> str:
        return f"{self.model_id} (Anthropic judge)"

    def generate(self, prompt: str, schema: Optional[type[BaseModel]] = None):
        client = self.load_model(async_mode=False)
        return self._run(lambda kw: client.beta.messages.parse(**kw) if "output_format" in kw else client.beta.messages.create(**kw),
                         prompt, schema)

    async def a_generate(self, prompt: str, schema: Optional[type[BaseModel]] = None):
        client = self.load_model(async_mode=True)
        async with self._sem():
            return await self._arun(client, prompt, schema)

    def supports_json_mode(self) -> bool:
        return True

    def supports_structured_outputs(self) -> bool:
        return True

    def supports_log_probs(self) -> bool:
        return False

    def supports_temperature(self) -> bool:
        return False

    # ------------------------------------------------------------------ internals
    def _sem(self) -> asyncio.Semaphore:
        loop_id = id(asyncio.get_running_loop())
        with self._lock:
            if loop_id not in self._sems:
                self._sems[loop_id] = asyncio.Semaphore(self.concurrency)
            return self._sems[loop_id]

    def _kwargs(self, prompt: str, schema, feedback: list[str], native: bool) -> dict:
        content = prompt
        if schema is not None and not native:
            js = json.dumps(schema.model_json_schema(), separators=(",", ":"))
            content += f"\n\n---\nReturn ONLY one JSON object that validates against this JSON Schema (no markdown, no commentary):\n{js}"
        messages = [{"role": "user", "content": content}]
        for fb in feedback:
            messages += [{"role": "assistant", "content": fb[1]}, {"role": "user", "content": fb[0]}]
        kw: dict[str, Any] = dict(model=self.model_id, max_tokens=self.max_tokens, system=SYSTEM, messages=messages,
                                  output_config={"effort": self.effort},
                                  betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        if schema is not None and native:
            kw["output_format"] = schema
        return kw

    def _account(self, msg) -> None:
        with self._lock:
            self.calls += 1
            u = getattr(msg, "usage", None)
            if u is None:
                return
            inp = (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
            self.prompt_tokens += inp
            self.completion_tokens += u.output_tokens or 0
            price = ANTHROPIC_PRICES.get(getattr(msg, "model", None) or self.model_id)
            if price:
                self.cost += inp / 1e6 * price[0] + (u.output_tokens or 0) / 1e6 * price[1]

    def _result(self, msg, schema, native: bool):
        if msg.stop_reason == "refusal":
            raise ValueError("the judge declined (stop_reason=refusal)")
        text = "".join(b.text for b in msg.content if b.type == "text")
        if schema is None:
            return text
        if native and getattr(msg, "parsed_output", None) is not None:
            return msg.parsed_output
        return schema.model_validate(extract_json(text)), text

    def _fatal_from(self, e: Exception) -> None:
        a = self._anthropic
        if isinstance(e, (a.AuthenticationError, a.PermissionDeniedError)) or (
                isinstance(e, a.BadRequestError) and "credit balance" in str(e).lower()):
            with self._lock:
                self.fatal = self.fatal or f"HTTP {e.status_code}: {str(e)[:300]}"
        if self.fatal:
            raise JudgeUnavailable(f"judge {self.model_id} unavailable: {self.fatal}")

    def _step(self, call, prompt, schema, state):
        """One API call with the current feedback / structured-output state."""
        if self.fatal:
            raise JudgeUnavailable(f"judge {self.model_id} unavailable: {self.fatal}")
        return call(self._kwargs(prompt, schema, state["feedback"], state["native"]))

    def _handle(self, msg, schema, state):
        self._account(msg)
        out = self._result(msg, schema, state["native"])
        return out[0] if isinstance(out, tuple) else out

    def _on_error(self, e: Exception, state) -> bool:
        """True = retry. A schema the structured-output endpoint rejects falls back to JSON-in-prompt once."""
        a = self._anthropic
        self._fatal_from(e)
        state["last"] = e
        if isinstance(e, a.BadRequestError) and state["native"]:
            state["native"] = False
            return True
        if isinstance(e, a.APIError) and not isinstance(e, (a.APIConnectionError, a.APITimeoutError)):
            return False  # other 4xx; 429/5xx were already retried by the SDK
        return True

    def _on_invalid(self, e: Exception, text: str, state) -> bool:
        state["last"] = e
        if len(state["feedback"]) + 1 >= self.max_attempts:
            return False
        state["native"] = False
        state["feedback"] = [(f"Your previous reply was not valid: {str(e)[:600]}\nReply again with ONLY the corrected JSON object.",
                              (text or "(empty)")[:1500])]
        return True

    def _run(self, call, prompt, schema):
        state = {"feedback": [], "native": schema is not None, "last": None}
        for _ in range(self.max_attempts + 2):
            try:
                msg = self._step(call, prompt, schema, state)
            except JudgeUnavailable:
                raise
            except Exception as e:
                if self._on_error(e, state):
                    continue
                break
            try:
                return self._handle(msg, schema, state)
            except (ValidationError, ValueError, json.JSONDecodeError) as e:
                text = "".join(b.text for b in msg.content if b.type == "text")
                if not self._on_invalid(e, text, state):
                    break
        with self._lock:
            self.failures += 1
        raise RuntimeError(f"judge {self.model_id} failed after retries: {state['last']}")

    async def _arun(self, client, prompt, schema):
        state = {"feedback": [], "native": schema is not None, "last": None}
        for _ in range(self.max_attempts + 2):
            if self.fatal:
                raise JudgeUnavailable(f"judge {self.model_id} unavailable: {self.fatal}")
            kw = self._kwargs(prompt, schema, state["feedback"], state["native"])
            try:
                msg = await (client.beta.messages.parse(**kw) if "output_format" in kw else client.beta.messages.create(**kw))
            except JudgeUnavailable:
                raise
            except Exception as e:
                if self._on_error(e, state):
                    continue
                break
            try:
                return self._handle(msg, schema, state)
            except (ValidationError, ValueError, json.JSONDecodeError) as e:
                text = "".join(b.text for b in msg.content if b.type == "text")
                if not self._on_invalid(e, text, state):
                    break
        with self._lock:
            self.failures += 1
        raise RuntimeError(f"judge {self.model_id} failed after retries: {state['last']}")

    def usage(self) -> dict:
        return {"model": self.model_id, "provider": "anthropic", "effort": self.effort, "fatal": self.fatal, "calls": self.calls,
                "failures": self.failures, "cost_usd": round(self.cost, 4),
                "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens}
