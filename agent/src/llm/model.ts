/**
 * Language model factory. Default: OpenRouter (`deepseek/deepseek-v4.1-flash`). A government / self-hosted model is used by
 * setting AGENT_PROVIDER=openai-compatible, AGENT_BASE_URL=<.../v1> and AGENT_MODEL (key in AGENT_API_KEY if needed).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { config, type Config } from "../config.js";

export function describeModel(cfg: Config = config()): { provider: string; model: string; base_url: string | null } {
  return { provider: cfg.provider, model: cfg.model, base_url: cfg.provider === "openai-compatible" ? cfg.baseUrl ?? null : "https://openrouter.ai/api/v1" };
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
  if (!cfg.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenRouter({
    apiKey: cfg.apiKey,
    headers: { "HTTP-Referer": "https://github.com/early-signals", "X-Title": "Early Signals agent" },
  }).chat(id) as unknown as LanguageModel;
}
