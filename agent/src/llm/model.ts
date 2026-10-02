/**
 * Language model factory. Default: OpenRouter (`deepseek/deepseek-v4.1-flash`). AGENT_PROVIDER=anthropic uses Claude through
 * the Anthropic Messages API (default `claude-sonnet-5-5`, key in ANTHROPIC_API_KEY). A government / self-hosted model is used
 * by setting AGENT_PROVIDER=openai-compatible, AGENT_BASE_URL=<.../v1> and AGENT_MODEL (key in AGENT_API_KEY if needed).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { config, type Config } from "../config.js";

export function describeModel(cfg: Config = config()): { provider: string; model: string; base_url: string | null } {
  const base_url = cfg.provider === "openai-compatible" ? cfg.baseUrl ?? null
    : cfg.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://openrouter.ai/api/v1";
  return { provider: cfg.provider, model: cfg.model, base_url };
}

/** Claude Sonnet 5.5, Opus 5.5 and Fable 5.1 return 400 on tool_choice `tool` / `any`. */
export function supportsForcedToolChoice(cfg: Config = config()): boolean {
  return !(cfg.provider === "anthropic" && /^claude-(sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)/.test(cfg.model));
}

/** Per-request provider options for streamText (usage accounting on OpenRouter; thinking, effort, refusal fallback on Claude). */
export function providerOptions(cfg: Config = config()): Record<string, Record<string, unknown>> {
  if (cfg.provider === "anthropic") {
    return { anthropic: { thinking: { type: "adaptive" }, effort: cfg.effort, fallbacks: "default" } };
  }
  return { openrouter: { usage: { include: true } } };
}

let override: LanguageModel | null = null;
/** Tests inject a mock model (ai/test MockLanguageModelV4). */
export function setModelOverride(m: LanguageModel | null): void {
  override = m;
}

export function languageModel(modelId?: string, cfg: Config = config()): LanguageModel {
  if (override) return override;
  const id = modelId || cfg.model;
  if (cfg.provider === "openai-compatible") {
    if (!cfg.baseUrl) throw new Error("AGENT_PROVIDER=openai-compatible needs AGENT_BASE_URL");
    return createOpenAICompatible({ name: "government", baseURL: cfg.baseUrl, apiKey: cfg.apiKey }).chatModel(id);
  }
  if (cfg.provider === "anthropic") {
    if (!cfg.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return createAnthropic({ apiKey: cfg.apiKey })(id);
  }
  if (!cfg.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenRouter({
    apiKey: cfg.apiKey,
    headers: { "HTTP-Referer": "https://github.com/early-signals", "X-Title": "Early Signals agent" },
  }).chat(id) as unknown as LanguageModel;
}
