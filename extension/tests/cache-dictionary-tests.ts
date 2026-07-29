import { addCachedTerms, buildExplanationCacheKey, detectCachedTerms, getCachedTerms, getPersistentExplanation, setPersistentExplanation } from "../src/background/cache.ts";
import { isCachedTermAvailable, mergeCachedTermView } from "../src/content/cache-view.ts";
import { getSettings } from "../src/shared/settings.ts";
import type { DetectedTerm, Explanation, LlmSettings } from "../src/shared/types.ts";

const now = Date.now();
const storage: Record<string, unknown> = {
  "termpop.explanationCache": [
    explanationEntry("fresh", now - 1_000),
    explanationEntry("expired", now - 15 * 24 * 60 * 60 * 1_000)
  ],
  "termpop.settings": {
    dictionary: {
      base: [],
      domain: [],
      user: [{ term: "星穹检索", term_type: "Custom", confidence: 1 }]
    }
  }
};

(globalThis as typeof globalThis & { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(keys: string | string[]) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.map((key) => [key, storage[key]]));
      },
      async set(values: Record<string, unknown>) {
        Object.assign(storage, values);
      }
    }
  }
};

await testTermCacheScopes();
await testExplanationCache();
await testUserDictionarySettings();
testContentCacheView();
console.log("ok - cache scopes, explanation persistence, and user dictionary settings");

async function testTermCacheScopes(): Promise<void> {
  const context = { url: "https://docs.example.com/a", pageFingerprint: "page-a" };
  await addCachedTerms([
    term("GlobalWidget", "User", 0.99),
    term("DomainWidget", "Ner", 0.91),
    term("PageWidget", "Ner", 0.7)
  ], context);

  equal(labels(await getCachedTerms(context)), "DomainWidget:domain|GlobalWidget:global|PageWidget:pageFingerprint");
  equal(labels(await getCachedTerms({ url: "https://docs.example.com/b", pageFingerprint: "page-b" })), "DomainWidget:domain|GlobalWidget:global");
  equal(labels(await getCachedTerms({ url: "https://other.example/b", pageFingerprint: "other" })), "GlobalWidget:global");
  equal((await detectCachedTerms("GlobalWidget DomainWidget PageWidget", context)).length, 3);
}

async function testExplanationCache(): Promise<void> {
  equal((await getPersistentExplanation("fresh"))?.term, "fresh");
  equal(await getPersistentExplanation("expired"), undefined);
  await setPersistentExplanation("new", explanation("new"));
  equal((await getPersistentExplanation("new"))?.term, "new");

  const settings = llmSettings();
  const base = buildExplanationCacheKey("Term", "context A", "page-a", settings);
  const variants = [
    buildExplanationCacheKey("Term", "context B", "page-a", settings),
    buildExplanationCacheKey("Term", "context A", "page-b", settings),
    buildExplanationCacheKey("Term", "context A", "page-a", { ...settings, language: "en" }),
    buildExplanationCacheKey("Term", "context A", "page-a", { ...settings, model: "model-b" }),
    buildExplanationCacheKey("Term", "context A", "page-a", { ...settings, includeUsageExample: true })
  ];
  ok(variants.every((key) => key !== base));
}

async function testUserDictionarySettings(): Promise<void> {
  const settings = await getSettings();
  equal(settings.dictionary.user.length, 1);
  equal(settings.dictionary.user[0].term, "星穹检索");
}

function testContentCacheView(): void {
  const pageA = { url: "https://docs.example.com/a", pageFingerprint: "page-a" };
  const view = mergeCachedTermView([], [term("OnlyHere", "Ner", 0.7)], pageA, now);
  equal(view[0].scope, "pageFingerprint");
  ok(isCachedTermAvailable(view[0], pageA));
  ok(!isCachedTermAvailable(view[0], { url: pageA.url, pageFingerprint: "page-b" }));

  const preserved = mergeCachedTermView([], [{
    term: "ScopedTerm",
    term_type: "Custom",
    confidence: 0.7,
    source: "Ner",
    scope: "pageFingerprint",
    domain: null,
    page_fingerprint: "server-page",
    last_seen_at: now
  }], pageA, now);
  equal(preserved[0].page_fingerprint, "server-page");
}

function term(value: string, source: DetectedTerm["source"], confidence: number): DetectedTerm {
  return { term: value, start: 0, end: value.length, term_type: "Custom", confidence, source };
}

function explanation(value: string): Explanation {
  return { term: value, definition: value, category: "test", related_terms: [], provider_status: "llm" };
}

function explanationEntry(key: string, createdAt: number) {
  return { key, explanation: explanation(key), created_at: createdAt, last_used_at: createdAt };
}

function llmSettings(): LlmSettings {
  return {
    provider: "openai-compatible",
    apiKey: "redacted",
    model: "model-a",
    baseUrl: "https://api.example/v1",
    language: "zh-CN",
    includeUsageExample: false,
    maxConcurrency: 5,
    temperature: 0.2,
    maxTokens: 450
  };
}

function labels(entries: Awaited<ReturnType<typeof getCachedTerms>>): string {
  return entries.map((entry) => `${entry.term}:${entry.scope}`).sort().join("|");
}

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function ok(value: unknown): asserts value {
  if (!value) {
    throw new Error("Expected value to be truthy.");
  }
}
