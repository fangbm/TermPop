import { createLlmConcurrencyController } from "../src/background/llm-queue.ts";
import { canUseCachedExplanation, pruneEntriesToByteBudget, serializedEntriesByteSize, utf8ByteSize } from "../src/background/cache-helpers.ts";
import { setPersistentExplanation } from "../src/background/cache.ts";
import { isSiteEnabledByPolicy } from "../src/background/site-access-policy.ts";
import { utf8ByteOffsetToUtf16Index } from "../src/shared/unicode.ts";
import type { Explanation } from "../src/shared/types.ts";

type TestCase = { name: string; run: () => void | Promise<void> };

const tests: TestCase[] = [
  {
    name: "all-sites access uses a per-origin blacklist and separate file permission",
    run: () => {
      const base = {
        originPattern: "https://bank.example/*",
        allSitesGranted: true,
        isFile: false,
        filePermission: false
      };
      equal(isSiteEnabledByPolicy({ ...base, blockedOrigins: [] }), true);
      equal(isSiteEnabledByPolicy({ ...base, blockedOrigins: [base.originPattern] }), false);
      equal(isSiteEnabledByPolicy({ ...base, allSitesGranted: false, blockedOrigins: [] }), false);
      equal(isSiteEnabledByPolicy({
        originPattern: "file:///*",
        allSitesGranted: true,
        isFile: true,
        filePermission: false,
        blockedOrigins: []
      }), false);
      equal(isSiteEnabledByPolicy({
        originPattern: "file:///*",
        allSitesGranted: false,
        isFile: true,
        filePermission: true,
        blockedOrigins: []
      }), true);
    }
  },
  {
    name: "structural explanation saves are awaited and retain concurrent changes",
    run: async () => {
      const stored: { explanations: unknown[] } = { explanations: [] };
      let writes = 0;
      (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: async () => ({ "termpop.explanationCache": stored.explanations }),
            set: async (value: { "termpop.explanationCache": unknown[] }) => {
              writes += 1;
              await delay(5);
              stored.explanations = value["termpop.explanationCache"];
            }
          }
        }
      };

      let firstSettled = false;
      const first = setPersistentExplanation("concurrent-one", testExplanation("one")).then(() => {
        firstSettled = true;
      });
      await delay(0);
      ok(!firstSettled);
      const second = setPersistentExplanation("concurrent-two", testExplanation("two"));
      await Promise.all([first, second]);

      equal(writes, 2);
      equal(stored.explanations.length, 2);
    }
  },
  {
    name: "real providers reject ambiguous legacy cache entries",
    run: () => {
      const legacy = testExplanation("legacy");
      equal(canUseCachedExplanation("openai", legacy), false);
      equal(canUseCachedExplanation("openai", { ...legacy, provider_status: "llm" }), true);
      equal(canUseCachedExplanation("mock", legacy), true);
    }
  },
  {
    name: "failed structural cache saves are handled without retry loops",
    run: async () => {
      let writes = 0;
      (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
        storage: {
          local: {
            set: async () => {
              writes += 1;
              throw new Error("storage unavailable");
            }
          }
        }
      };

      await setPersistentExplanation("failed-save", testExplanation("failed"));
      await delay(20);
      equal(writes, 1);
    }
  },
  {
    name: "UTF-8 byte offsets map to UTF-16 indices",
    run: () => {
      equal(utf8ByteOffsetToUtf16Index("😀Rust", 4), 2);
      equal(utf8ByteOffsetToUtf16Index("éRust", 2), 1);
      equal(utf8ByteOffsetToUtf16Index("Rust", 4), 4);
    }
  },
  {
    name: "cache pruning respects UTF-8 serialized byte budgets",
    run: () => {
      const newest = { key: "new", last_used_at: 2, explanation: "😀".repeat(20) };
      const older = { key: "old", last_used_at: 1, explanation: "older" };
      const budget = serializedEntriesByteSize([newest]);
      const kept = pruneEntriesToByteBudget([older, newest], 5, budget);
      equal(kept.length, 1);
      equal(kept[0].key, "new");
      ok(utf8ByteSize(kept) <= budget);
    }
  },
  {
    name: "global concurrency includes detection and explanation work",
    run: async () => {
      const controller = createLlmConcurrencyController();
      const settings = testSettings(3);
      let active = 0;
      let maximum = 0;
      const jobs = Array.from({ length: 18 }, (_, index) => controller.run(
        settings,
        { priority: index % 2 === 0 ? "detection" : "explanation", timeoutMs: 1_000 },
        async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await delay(2);
          active -= 1;
          return index;
        }
      ));
      await Promise.all(jobs);
      equal(maximum, 3);
    }
  },
  {
    name: "explanations are prioritized without starving detection",
    run: async () => {
      const controller = createLlmConcurrencyController();
      const settings = testSettings(1);
      const starts: string[] = [];
      const releases: Array<() => void> = [];
      const task = (priority: "detection" | "explanation") => controller.run(settings, { priority, timeoutMs: 1_000 }, async () => {
        starts.push(priority);
        await new Promise<void>((resolve) => releases.push(resolve));
      });

      const first = task("detection");
      const queuedDetection = task("detection");
      const explanations = [task("explanation"), task("explanation"), task("explanation"), task("explanation")];
      await delay(0);
      releases.shift()?.();
      await delay(0);
      equal(starts.slice(0, 2).join(","), "detection,explanation");
      releases.shift()?.();
      await delay(0);
      releases.shift()?.();
      await delay(0);
      releases.shift()?.();
      await delay(0);
      equal(starts.slice(0, 5).join(","), "detection,explanation,explanation,explanation,detection");
      releases.shift()?.();
      await delay(0);
      releases.shift()?.();
      await Promise.all([first, queuedDetection, ...explanations]);
    }
  },
  {
    name: "queued requests time out and release their queue entry",
    run: async () => {
      const controller = createLlmConcurrencyController();
      const settings = testSettings(1);
      let releaseFirst!: () => void;
      const first = controller.run(settings, { priority: "detection", timeoutMs: 1_000 }, () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }));
      const timedOut = controller.run(settings, { priority: "explanation", timeoutMs: 5 }, async () => undefined);
      await rejects(timedOut, "timed out");
      releaseFirst();
      await first;
    }
  }
];

for (const test of tests) {
  await test.run();
  console.log(`ok - ${test.name}`);
}

function testSettings(maxConcurrency: number) {
  return {
    provider: "mock" as const,
    apiKey: "",
    model: "mock",
    baseUrl: "https://api.openai.com/v1",
    language: "en" as const,
    includeUsageExample: false,
    maxConcurrency,
    temperature: 0.2,
    maxTokens: 128
  };
}

function testExplanation(term: string): Explanation {
  return {
    term,
    definition: "definition",
    category: "test",
    related_terms: [],
    usage_example: null
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejects(value: Promise<unknown>, expected: string): Promise<void> {
  try {
    await value;
  } catch (error) {
    ok(String(error).toLocaleLowerCase().includes(expected));
    return;
  }
  throw new Error("Expected promise to reject.");
}

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function ok(value: unknown): asserts value {
  if (!value) {
    throw new Error("Expected a truthy value.");
  }
}
