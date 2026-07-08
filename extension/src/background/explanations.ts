import type { Explanation, ExplanationLanguage, LlmSettings } from "../shared/types";
import { buildExplanationCacheKey, getPersistentExplanation, setPersistentExplanation } from "./cache";
import { createLlmProvider } from "./llm-provider";
import { explainWithWasm } from "./wasm-runtime";

const explanationCache = new Map<string, Explanation>();

export async function explain(
  term: string,
  context: string | undefined,
  cacheScope: string | undefined,
  refresh: boolean,
  settings: LlmSettings
): Promise<Explanation> {
  const cacheKey = buildExplanationCacheKey(term, context, cacheScope, settings);
  if (!refresh) {
    const cached = explanationCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const persistent = await getPersistentExplanation(cacheKey);
    if (persistent) {
      explanationCache.set(cacheKey, persistent);
      return persistent;
    }
  }

  const explanation = settings.provider === "mock" || !settings.apiKey.trim()
    ? await mockExplain(term, context, settings.language, settings.includeUsageExample)
    : await createLlmProvider(settings).explain(term, context, settings);

  explanationCache.set(cacheKey, explanation);
  await setPersistentExplanation(cacheKey, explanation);
  return explanation;
}

async function mockExplain(term: string, context: string | undefined, language: ExplanationLanguage, includeUsageExample: boolean): Promise<Explanation> {
  const raw = await explainWithWasm(term, context);
  const explanation = JSON.parse(raw) as Explanation;
  if (language === "zh-CN") {
    return {
      ...explanation,
      definition: `${term} 是 TermPop 在当前上下文中识别出的术语，可结合附近内容理解。`,
      category: explanation.category || "术语",
      usage_example: includeUsageExample ? `阅读时悬停 ${term} 可以快速查看上下文解释。` : null
    };
  }
  return {
    ...explanation,
    usage_example: includeUsageExample ? explanation.usage_example : null
  };
}
