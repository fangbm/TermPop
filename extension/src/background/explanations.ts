import type { Explanation, ExplanationLanguage, LlmSettings } from "../shared/types";
import { buildExplanationCacheKey, getPersistentExplanation, setPersistentExplanation } from "./cache";
import { createLlmProvider } from "./llm-provider";
import { assertLlmProviderAuthorized } from "./provider-access";
import { explainWithWasm } from "./wasm-runtime";
import { canUseCachedExplanation } from "./cache-helpers";

const explanationCache = new Map<string, Explanation>();

export async function explain(
  term: string,
  context: string | undefined,
  cacheScope: string | undefined,
  refresh: boolean,
  settings: LlmSettings
): Promise<Explanation> {
  const cacheKey = buildExplanationCacheKey(term, context, cacheScope, settings);
  const missingApiKey = settings.provider !== "mock" && !settings.apiKey.trim();
  const canUseCache = !missingApiKey;
  if (!refresh && canUseCache) {
    const cached = explanationCache.get(cacheKey);
    if (cached && canUseCachedExplanation(settings.provider, cached)) {
      return cached;
    }
    const persistent = await getPersistentExplanation(cacheKey);
    if (persistent && canUseCachedExplanation(settings.provider, persistent)) {
      explanationCache.set(cacheKey, persistent);
      return persistent;
    }
  }

  if (!missingApiKey) {
    await assertLlmProviderAuthorized(settings);
  }
  const explanation = settings.provider === "mock" || missingApiKey
    ? await mockExplain(term, context, settings.language, settings.includeUsageExample, missingApiKey)
    : await createLlmProvider(settings).explain(term, context, settings);

  if (!missingApiKey) {
    explanationCache.set(cacheKey, explanation);
    await setPersistentExplanation(cacheKey, explanation);
  }
  return explanation;
}

async function mockExplain(term: string, context: string | undefined, language: ExplanationLanguage, includeUsageExample: boolean, missingApiKey = false): Promise<Explanation> {
  const raw = await explainWithWasm(term, context);
  const explanation = JSON.parse(raw) as Explanation;
  if (language === "zh-CN") {
    return {
      ...explanation,
      provider_status: "mock",
      ...(missingApiKey ? { fallback_reason: "missing-api-key" as const } : {}),
      definition: `${term} 是 TermPop 在当前上下文中识别出的术语，可结合附近内容理解。`,
      category: explanation.category || "术语",
      usage_example: includeUsageExample ? `阅读时悬停 ${term} 可以快速查看上下文解释。` : null
    };
  }
  return {
    ...explanation,
    provider_status: "mock",
    ...(missingApiKey ? { fallback_reason: "missing-api-key" as const } : {}),
    usage_example: includeUsageExample ? explanation.usage_example : null
  };
}
