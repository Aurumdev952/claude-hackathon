"""Pluggable LLM providers (SPEC §15.1).

  ollama    - local model over HTTP (default for offline demos; configured in config/llm.yaml)
  anthropic - Claude via the official Anthropic SDK (optional extra `llm`); only de-identified payloads are sent
  template  - deterministic fallback, always available; used when the provider is switched off or times out
"""
from __future__ import annotations

import os
from typing import Protocol

import httpx

from shared.config import llm_cfg


class LLMUnavailable(RuntimeError):
    pass


class LLMProvider(Protocol):
    name: str
    remote: bool

    def complete(self, system: str, messages: list[dict], *, max_tokens: int, temperature: float = 0.0,
                 json_mode: bool = False, purpose: str = "text", timeout: float | None = None) -> str: ...


class OllamaProvider:
    name, remote = "ollama", False

    def __init__(self, cfg: dict):
        self.base = os.environ.get("OLLAMA_BASE_URL", cfg["ollama"]["base_url"]).rstrip("/")
        self.sql_model = cfg["ollama"]["sql_model"]
        self.text_model = cfg["ollama"]["text_model"]

    def complete(self, system, messages, *, max_tokens, temperature=0.0, json_mode=False, purpose="text", timeout=None):
        body = {"model": self.sql_model if purpose == "sql" else self.text_model, "stream": False,
                "messages": [{"role": "system", "content": system}] + messages,
                "options": {"temperature": temperature, "num_predict": max_tokens}}
        if json_mode:
            body["format"] = "json"
        try:
            r = httpx.post(f"{self.base}/api/chat", json=body, timeout=timeout or 20.0)
            r.raise_for_status()
            return r.json()["message"]["content"]
        except (httpx.HTTPError, KeyError, ValueError) as e:
            raise LLMUnavailable(f"ollama: {e}") from e


class AnthropicProvider:
    """Claude via the official SDK. Model comes from config/llm.yaml (SPEC §15.1 names claude-sonnet-5-5)."""
    name, remote = "anthropic", True

    def __init__(self, cfg: dict):
        try:
            import anthropic
        except ImportError as e:  # optional dependency
            raise LLMUnavailable("install the `llm` extra to use LLM_PROVIDER=anthropic") from e
        self._anthropic = anthropic
        self.model = cfg["anthropic"]["model"]
        self.client = anthropic.Anthropic(max_retries=1)

    def complete(self, system, messages, *, max_tokens, temperature=0.0, json_mode=False, purpose="text", timeout=None):
        a = self._anthropic
        try:
            resp = self.client.with_options(timeout=timeout or 20.0).beta.messages.create(
                model=self.model, max_tokens=max(max_tokens, 1024), system=system, messages=messages,
                output_config={"effort": "low"},  # short, factual generations
                betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        except (a.APIConnectionError, a.APITimeoutError, a.RateLimitError, a.APIStatusError) as e:
            raise LLMUnavailable(f"anthropic: {e.__class__.__name__}") from e
        if resp.stop_reason == "refusal":
            raise LLMUnavailable("anthropic: refusal")
        text = "".join(b.text for b in resp.content if b.type == "text")
        if not text:
            raise LLMUnavailable("anthropic: empty response")
        return text


class TemplateProvider:
    """No model: callers fall back to their deterministic templates / rule-based SQL."""
    name, remote = "template", False

    def complete(self, *a, **k):
        raise LLMUnavailable("template provider")


_PROVIDER = None


def get_provider() -> LLMProvider:
    global _PROVIDER
    if _PROVIDER is None:
        cfg = llm_cfg()
        kind = cfg["provider"]
        try:
            _PROVIDER = {"ollama": OllamaProvider, "anthropic": AnthropicProvider}.get(kind, lambda c: TemplateProvider())(cfg)
        except LLMUnavailable:
            _PROVIDER = TemplateProvider()
    return _PROVIDER


def reset_provider():
    global _PROVIDER
    _PROVIDER = None
