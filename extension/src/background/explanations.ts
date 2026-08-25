import type { Explanation, FollowUpStreamResult, FollowUpTurn, LlmSettings } from "../shared/types";
import { buildExplanationCacheKey, getPersistentExplanation, setPersistentExplanation } from "./cache";
import { createLlmProvider, type FollowUpStreamCallbacks } from "./llm-provider";
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

export async function followUp(
  term: string,
  context: string | undefined,
  explanation: Explanation,
  history: FollowUpTurn[],
  question: string,
  images: { termImageDataUrl: string; contextImageDataUrl: string } | undefined,
  settings: LlmSettings
): Promise<string> {
  await assertLlmProviderAuthorized(settings);
  return createLlmProvider(settings).followUp(term, context, explanation, history, question, images, settings);
}

export async function followUpStream(
  term: string,
  context: string | undefined,
  explanation: Explanation,
  history: FollowUpTurn[],
  question: string,
  images: { termImageDataUrl: string; contextImageDataUrl: string } | undefined,
  settings: LlmSettings,
  callbacks: FollowUpStreamCallbacks,
  signal?: AbortSignal
): Promise<FollowUpStreamResult> {
  await assertLlmProviderAuthorized(settings);
  return createLlmProvider(settings).followUpStream(term, context, explanation, history, question, images, settings, callbacks, signal);
}
