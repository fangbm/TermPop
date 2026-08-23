import type { Explanation, LlmSettings } from "../shared/types";
import { buildExplanationCacheKey, getPersistentExplanation, setPersistentExplanation } from "./cache";
import { createLlmProvider } from "./llm-provider";
import { assertLlmProviderAuthorized } from "./provider-access";
import { canUseCachedExplanation } from "./cache-helpers";

const explanationCache = new Map<string, Explanation>();

export async function storeExplanation(
  term: string,
  context: string | undefined,
  cacheScope: string | undefined,
  settings: LlmSettings,
  explanation: Explanation
): Promise<void> {
  const cacheKey = buildExplanationCacheKey(term, context, cacheScope, settings);
  explanationCache.set(cacheKey, explanation);
  await setPersistentExplanation(cacheKey, explanation);
}

export async function explain(
  term: string,
  context: string | undefined,
  cacheScope: string | undefined,
  refresh: boolean,
  settings: LlmSettings
): Promise<Explanation> {
  const cacheKey = buildExplanationCacheKey(term, context, cacheScope, settings);
  await assertLlmProviderAuthorized(settings);

  if (!refresh) {
    const cached = explanationCache.get(cacheKey);
    if (cached && canUseCachedExplanation(cached)) {
      return cached;
    }
    const persistent = await getPersistentExplanation(cacheKey);
    if (persistent && canUseCachedExplanation(persistent)) {
      explanationCache.set(cacheKey, persistent);
      return persistent;
    }
  }

  const explanation = await createLlmProvider(settings).explain(term, context, settings);
  explanationCache.set(cacheKey, explanation);
  await setPersistentExplanation(cacheKey, explanation);
  return explanation;
}
