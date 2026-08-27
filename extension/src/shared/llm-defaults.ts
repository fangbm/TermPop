import type { LlmProvider } from "./types";

export function defaultBaseUrl(provider: LlmProvider): string {
  if (provider === "kimi") {
    return "https://api.moonshot.cn/v1";
  }
  if (provider === "deepseek") {
    return "https://api.deepseek.com/v1";
  }
  if (provider === "stepfun") {
    return "https://api.stepfun.com/v1";
  }
  if (provider === "step-plan") {
    return "https://api.stepfun.com/step_plan/v1";
  }
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
