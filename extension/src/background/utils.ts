import type { Explanation, ExplanationLanguage, LlmProvider } from "../shared/types";
import { sanitizeForLog as sanitizeValueForLog } from "../shared/browser-utils";
export { hashString, sanitizeForLog } from "../shared/browser-utils";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function normalizeCacheTerm(term: string): string {
  return term.trim().toLocaleLowerCase();
}

export function normalizeCacheContext(context: string | undefined): string {
  return (context ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function isDebugLoggingEnabled(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("termpopDebug") === "1";
  } catch {
    return false;
  }
}

export function debugLog(message: string, payload?: unknown): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }
  console.info(message, sanitizeValueForLog(payload, 700));
}

export function languageInstruction(language: ExplanationLanguage): string {
  if (language === "zh-CN") {
    return "Respond in Simplified Chinese.";
  }
  if (language === "en") {
    return "Respond in English.";
  }
  return "Respond in the same language as the surrounding context when possible.";
}

export function defaultBaseUrl(provider: LlmProvider): string {
  if (provider === "kimi") {
    return "https://api.moonshot.cn/v1";
  }
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

export function defaultModel(provider: LlmProvider): string {
  if (provider === "kimi") {
    return "moonshot-v1-8k";
  }
  if (provider === "anthropic") {
    return "claude-3-5-haiku-latest";
  }
  if (provider === "mock") {
    return "mock";
  }
  return "gpt-4.1-mini";
}

export function isExplanation(value: unknown): value is Explanation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const object = value as Partial<Explanation>;
  return typeof object.term === "string"
    && typeof object.definition === "string"
    && typeof object.category === "string"
    && Array.isArray(object.related_terms);
}
