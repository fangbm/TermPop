import initWasm, { detect_terms_json, explain_term_json } from "../wasm/termpop_core.js";
import { getSettings } from "../shared/settings";
import { filterAllowedDetectedTerms, findAllowedOccurrences, findAllowedOccurrencesIgnoreCase } from "../shared/term-matching";
import type {
  AddCachedTermsRequest,
  AddCachedTermsResponse,
  CachedTermEntry,
  DetectTermsDebug,
  DetectTermsRequest,
  DetectTermsResponse,
  DetectedTerm,
  ExplanationLanguage,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  ExplainRequest,
  ExplainResponse,
  ExplainSelectionRequest,
  Explanation,
  LlmSettings,
  TermType
} from "../shared/types";

const explanationCache = new Map<string, Explanation>();
const detectionCache = new Map<string, DetectedTerm[]>();
const wasmReady = initWasm({ module_or_path: chrome.runtime.getURL("assets/termpop_core_bg.wasm") });
const GLOBAL_TERM_CACHE_KEY = "termpop.globalTermCache";
const EXPLANATION_CACHE_KEY = "termpop.explanationCache";
const MAX_GLOBAL_CACHED_TERMS = 3000;
const MAX_EXPLANATION_CACHE_ENTRIES = 5000;
const EXPLANATION_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SETTINGS_KEY = "termpop.settings";
const SELECTION_CONTEXT_MENU_ID = "termpop-explain-selection";
const LLM_DETECTION_TIMEOUT_MS = 120000;
const LLM_DETECTION_CHUNK_SIZE = 3000;
const LLM_DETECTION_CHUNK_OVERLAP = 80;
const LLM_REJECTED_SIMPLE_TERMS = new Set([
  "task",
  "tasks",
  "data",
  "model",
  "models",
  "result",
  "results",
  "best",
  "new",
  "old",
  "french",
  "german",
  "english"
]);
let activeExplanationRequests = 0;
let activeDetectionRequests = 0;
let globalTermCache: Map<string, CachedTermEntry> | undefined;
let persistentExplanationCache: Map<string, CachedExplanationEntry> | undefined;
const explanationQueue: LlmQueueEntry[] = [];
const detectionQueue: LlmQueueEntry[] = [];

type LlmPriority = "explanation" | "detection";

interface LlmRunOptions {
  priority: LlmPriority;
  timeoutMs?: number;
}

interface LlmQueueEntry {
  start: () => void;
  signal: AbortSignal;
  priority: LlmPriority;
  maxActiveRequests: number;
}

interface CachedExplanationEntry {
  key: string;
  explanation: Explanation;
  created_at: number;
  last_used_at: number;
}

interface DetectionResult {
  terms: DetectedTerm[];
  debug?: DetectTermsDebug;
}

interface ParsedDetectedTerms {
  terms: DetectedTerm[];
  debug: Required<Pick<DetectTermsDebug, "rawCandidateCount" | "matchedCount" | "rejectedCount" | "unmatchedCount" | "sampleCandidates" | "sampleMatchedTerms">>;
}

interface DetectedTermCandidate {
  term?: unknown;
  term_type?: unknown;
  type?: unknown;
  category?: unknown;
  confidence?: unknown;
}

void syncContextMenus();

chrome.runtime.onInstalled.addListener(() => {
  void syncContextMenus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    void syncContextMenus();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SELECTION_CONTEXT_MENU_ID && tab?.id && info.selectionText?.trim()) {
    void getSettings().then(async (settings) => {
      if (settings.mode === "hover") {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id as number, {
          type: "TERMPOP_EXPLAIN_SELECTION",
          term: info.selectionText ?? ""
        } satisfies ExplainSelectionRequest);
      } catch (error) {
        console.warn("TermPop selection explain could not run on this page.", error);
      }
    });
  }
});

async function syncContextMenus(): Promise<void> {
  const settings = await getSettings();
  syncSelectionContextMenu(settings);
}

function syncSelectionContextMenu(settings: Awaited<ReturnType<typeof getSettings>>): void {
  const visible = settings.mode === "selection" || settings.mode === "hybrid";
  const title = settings.llm.language === "en" ? "Explain selection with TermPop" : "用 TermPop 解释选中文本";

  chrome.contextMenus.update(SELECTION_CONTEXT_MENU_ID, { title, visible }, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    chrome.contextMenus.create(
      {
        id: SELECTION_CONTEXT_MENU_ID,
        title,
        contexts: ["selection"],
        visible
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

chrome.runtime.onMessage.addListener(
  (message: ExplainRequest | DetectTermsRequest | GetCachedTermsRequest | AddCachedTermsRequest, _sender, sendResponse) => {
  if (message.type === "TERMPOP_GET_CACHED_TERMS") {
    getCachedTerms()
      .then((terms) => sendResponse({ ok: true, terms } satisfies GetCachedTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies GetCachedTermsResponse);
      });
    return true;
  }

  if (message.type === "TERMPOP_ADD_CACHED_TERMS") {
    addGlobalCachedTerms(message.terms)
      .then(() => sendResponse({ ok: true } satisfies AddCachedTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies AddCachedTermsResponse);
      });
    return true;
  }

  if (message.type === "TERMPOP_DETECT_TERMS") {
    detectTerms(message.text, message.detectionMode ?? "all")
      .then((result) => sendResponse({ ok: true, terms: result.terms, debug: result.debug } satisfies DetectTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies DetectTermsResponse);
      });
    return true;
  }

  if (message.type !== "TERMPOP_EXPLAIN") {
    return false;
  }

  explain(message.term, message.context, message.cacheScope, message.refresh ?? false)
    .then((explanation) => sendResponse({ ok: true, explanation } satisfies ExplainResponse))
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: reason } satisfies ExplainResponse);
    });

  return true;
});

async function detectTerms(text: string, detectionMode: "primary" | "llm" | "all"): Promise<DetectionResult> {
  await wasmReady;
  const settings = await getSettings();
  const trimmed = text.trim();
  if (!trimmed) {
    return { terms: [] };
  }

  const cacheKey = `${detectionMode}\n${settings.llm.provider}\n${settings.llm.baseUrl}\n${settings.llm.model}\n${settings.llm.language}\n${text}`;
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    return { terms: cached };
  }

  const primaryTerms = dedupeDetectedTerms(filterAllowedDetectedTerms(text, [
    ...rustDetect(text),
    ...await detectGlobalCachedTerms(text)
  ]));
  if (detectionMode === "primary") {
    detectionCache.set(cacheKey, primaryTerms);
    return { terms: primaryTerms };
  }

  let llmTerms: DetectedTerm[] = [];
  let llmDebug: DetectTermsDebug | undefined;
  if (settings.llm.provider !== "mock" && settings.llm.apiKey.trim()) {
    try {
      const result = await fetchLlmDetectedTerms(text, settings.llm);
      llmTerms = result.terms;
      llmDebug = result.debug;
    } catch (error) {
      if (detectionMode === "llm") {
        throw error;
      }
    }
  }

  if (detectionMode === "llm") {
    llmTerms = dedupeDetectedTerms(filterAllowedDetectedTerms(text, llmTerms));
    detectionCache.set(cacheKey, llmTerms);
    return { terms: llmTerms, debug: { ...llmDebug, matchedCount: llmTerms.length } };
  }

  const terms = mergePrimaryThenLlmTerms(
    primaryTerms,
    dedupeDetectedTerms(filterAllowedDetectedTerms(text, llmTerms))
  );
  void addGlobalCachedTerms(primaryTerms);
  detectionCache.set(cacheKey, terms);
  return { terms, debug: llmDebug };
}

async function getCachedTerms(): Promise<CachedTermEntry[]> {
  const cache = await loadGlobalTermCache();
  return [...cache.values()];
}

async function detectGlobalCachedTerms(text: string): Promise<DetectedTerm[]> {
  const cache = await loadGlobalTermCache();
  const terms: DetectedTerm[] = [];

  for (const entry of cache.values()) {
    if (isRejectedLlmSimpleTerm(entry.term)) {
      continue;
    }

    for (const [start, end] of findAllowedOccurrences(text, entry.term)) {
      terms.push({
        term: text.slice(start, end),
        start,
        end,
        term_type: entry.term_type,
        confidence: Math.min(entry.confidence, 0.88),
        source: "Dictionary"
      });
    }
  }

  return dedupeDetectedTerms(terms);
}

async function addGlobalCachedTerms(terms: DetectedTerm[]): Promise<void> {
  const cache = await loadGlobalTermCache();
  let changed = false;
  const now = Date.now();

  for (const term of terms) {
    if (term.source === "Ner") {
      continue;
    }

    const normalized = normalizeCacheTerm(term.term);
    if (!shouldCacheTerm(term.term, normalized)) {
      continue;
    }

    const existing = cache.get(normalized);
    if (!existing || term.confidence >= existing.confidence) {
      cache.set(normalized, {
        term: term.term.trim(),
        term_type: term.term_type,
        confidence: Math.max(term.confidence, existing?.confidence ?? 0),
        source: term.source,
        last_seen_at: now
      });
      changed = true;
      continue;
    }

    existing.last_seen_at = now;
    changed = true;
  }

  if (!changed) {
    return;
  }

  pruneGlobalTermCache(cache);
  detectionCache.clear();
  await chrome.storage.local.set({
    [GLOBAL_TERM_CACHE_KEY]: [...cache.values()]
  });
}

async function loadGlobalTermCache(): Promise<Map<string, CachedTermEntry>> {
  if (globalTermCache) {
    return globalTermCache;
  }

  const stored = await chrome.storage.local.get(GLOBAL_TERM_CACHE_KEY);
  const terms = Array.isArray(stored[GLOBAL_TERM_CACHE_KEY]) ? stored[GLOBAL_TERM_CACHE_KEY] as CachedTermEntry[] : [];
  globalTermCache = new Map();
  for (const entry of terms) {
    if (entry.source === "Ner") {
      continue;
    }

    const normalized = normalizeCacheTerm(entry.term);
    if (shouldCacheTerm(entry.term, normalized)) {
      globalTermCache.set(normalized, {
        term: entry.term,
        term_type: normalizeTermType(entry.term_type),
        confidence: normalizeConfidence(entry.confidence),
        source: normalizeDetectionSource(entry.source),
        last_seen_at: Number.isFinite(entry.last_seen_at) ? entry.last_seen_at : 0
      });
    }
  }
  pruneGlobalTermCache(globalTermCache);
  return globalTermCache;
}

function pruneGlobalTermCache(cache: Map<string, CachedTermEntry>): void {
  if (cache.size <= MAX_GLOBAL_CACHED_TERMS) {
    return;
  }

  const keep = [...cache.values()]
    .sort((left, right) => right.last_seen_at - left.last_seen_at || right.confidence - left.confidence)
    .slice(0, MAX_GLOBAL_CACHED_TERMS);
  cache.clear();
  for (const entry of keep) {
    cache.set(normalizeCacheTerm(entry.term), entry);
  }
}

function shouldCacheTerm(term: string, normalized: string): boolean {
  const trimmed = term.trim();
  return trimmed.length >= 2
    && trimmed.length <= 80
    && normalized.length >= 2
    && !isRejectedLlmSimpleTerm(trimmed);
}

async function explain(term: string, context: string | undefined, cacheScope: string | undefined, refresh: boolean): Promise<Explanation> {
  await wasmReady;
  const settings = await getSettings();

  const cacheKey = buildExplanationCacheKey(term, context, cacheScope, settings.llm);
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

  const explanation =
    settings.llm.provider === "mock" || !settings.llm.apiKey.trim()
      ? mockExplain(term, context, settings.llm.language, settings.llm.includeUsageExample)
      : await fetchLlmExplanation(term, context, settings.llm);

  explanationCache.set(cacheKey, explanation);
  await setPersistentExplanation(cacheKey, explanation);
  return explanation;
}

async function getPersistentExplanation(cacheKey: string): Promise<Explanation | undefined> {
  const cache = await loadPersistentExplanationCache();
  const cached = cache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  const now = Date.now();
  if (now - cached.created_at > EXPLANATION_CACHE_TTL_MS) {
    cache.delete(cacheKey);
    void savePersistentExplanationCache(cache);
    return undefined;
  }

  cached.last_used_at = now;
  void savePersistentExplanationCache(cache);
  return cached.explanation;
}

async function setPersistentExplanation(cacheKey: string, explanation: Explanation): Promise<void> {
  const cache = await loadPersistentExplanationCache();
  const now = Date.now();
  cache.set(cacheKey, {
    key: cacheKey,
    explanation,
    created_at: cache.get(cacheKey)?.created_at ?? now,
    last_used_at: now
  });
  prunePersistentExplanationCache(cache);
  await savePersistentExplanationCache(cache);
}

async function loadPersistentExplanationCache(): Promise<Map<string, CachedExplanationEntry>> {
  if (persistentExplanationCache) {
    return persistentExplanationCache;
  }

  const stored = await chrome.storage.local.get(EXPLANATION_CACHE_KEY);
  const entries = Array.isArray(stored[EXPLANATION_CACHE_KEY]) ? stored[EXPLANATION_CACHE_KEY] as CachedExplanationEntry[] : [];
  const now = Date.now();
  persistentExplanationCache = new Map();

  for (const entry of entries) {
    if (!entry?.key || !isExplanation(entry.explanation)) {
      continue;
    }

    const createdAt = Number.isFinite(entry.created_at) ? entry.created_at : now;
    if (now - createdAt > EXPLANATION_CACHE_TTL_MS) {
      continue;
    }

    persistentExplanationCache.set(entry.key, {
      key: entry.key,
      explanation: entry.explanation,
      created_at: createdAt,
      last_used_at: Number.isFinite(entry.last_used_at) ? entry.last_used_at : createdAt
    });
  }

  prunePersistentExplanationCache(persistentExplanationCache);
  return persistentExplanationCache;
}

async function savePersistentExplanationCache(cache: Map<string, CachedExplanationEntry>): Promise<void> {
  await chrome.storage.local.set({
    [EXPLANATION_CACHE_KEY]: [...cache.values()]
  });
}

function prunePersistentExplanationCache(cache: Map<string, CachedExplanationEntry>): void {
  if (cache.size <= MAX_EXPLANATION_CACHE_ENTRIES) {
    return;
  }

  const keep = [...cache.values()]
    .sort((left, right) => right.last_used_at - left.last_used_at || right.created_at - left.created_at)
    .slice(0, MAX_EXPLANATION_CACHE_ENTRIES);
  cache.clear();
  for (const entry of keep) {
    cache.set(entry.key, entry);
  }
}

function buildExplanationCacheKey(term: string, context: string | undefined, cacheScope: string | undefined, settings: LlmSettings): string {
  const provider = settings.provider;
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const model = settings.model || defaultModel(settings.provider);
  const normalizedTerm = normalizeCacheTerm(term);
  const contextFingerprint = hashString(normalizeCacheContext(context));
  const scopeFingerprint = hashString((cacheScope || "global").slice(0, 1200));
  return [
    provider,
    baseUrl,
    model,
    settings.language,
    settings.includeUsageExample ? "example" : "no-example",
    normalizedTerm,
    scopeFingerprint,
    contextFingerprint
  ].join("\n");
}

function normalizeCacheContext(context: string | undefined): string {
  return (context ?? "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function mockExplain(term: string, context: string | undefined, language: ExplanationLanguage, includeUsageExample: boolean): Explanation {
  if (language === "zh-CN") {
    return {
      term,
      definition: `${term} 是当前上下文中值得解释的术语。${context?.trim() ? `它出现在这段内容附近：“${truncate(context.trim(), 120)}”。` : ""}`,
      category: "术语",
      related_terms: ["上下文", "用法", "背景"],
      usage_example: includeUsageExample ? `阅读页面时悬停 ${term}，可以快速查看它在当前语境里的含义。` : null,
      source_url: null
    };
  }

  const raw = explain_term_json(term, context);
  const explanation = JSON.parse(raw) as Explanation;
  return {
    ...explanation,
    usage_example: includeUsageExample ? explanation.usage_example : null
  };
}

async function fetchLlmExplanation(
  term: string,
  context: string | undefined,
  settings: LlmSettings
): Promise<Explanation> {
  return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) => {
    if (settings.provider === "anthropic") {
      return fetchAnthropicExplanation(term, context, settings, signal);
    }

    return fetchOpenAiCompatibleExplanation(term, context, settings, signal);
  });
}

async function fetchOpenAiCompatibleExplanation(
  term: string,
  context: string | undefined,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<Explanation> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      messages: [
        {
          role: "system",
          content: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample)
        },
        {
          role: "user",
          content: buildPrompt(term, context, settings.language, settings.includeUsageExample)
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = await response.json();
  const content = extractOpenAiCompatibleText(payload);

  return parseExplanation(content, term, settings.includeUsageExample);
}

async function fetchAnthropicExplanation(
  term: string,
  context: string | undefined,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<Explanation> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      system: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample),
      messages: [
        {
          role: "user",
          content: buildPrompt(term, context, settings.language, settings.includeUsageExample)
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find((part) => part.type === "text")?.text;
  if (!content) {
    throw new Error(`LLM response did not include text content. Raw response: ${truncate(JSON.stringify(payload), 500)}`);
  }

  return parseExplanation(content, term, settings.includeUsageExample);
}

async function fetchLlmDetectedTerms(text: string, settings: LlmSettings): Promise<DetectionResult> {
  const terms: DetectedTerm[] = [];
  const chunks = splitTextForLlmDetection(text);
  const debug: DetectTermsDebug = {
    rawCandidateCount: 0,
    matchedCount: 0,
    rejectedCount: 0,
    unmatchedCount: 0,
    chunkCount: chunks.length,
    sampleCandidates: [],
    sampleMatchedTerms: []
  };

  for (const chunk of chunks) {
    const prompt = buildTermExtractionPrompt(chunk.text, settings.language, chunk.index + 1, chunks.length);
    const content = settings.provider === "anthropic"
      ? await runWithLlmConcurrency(settings, { priority: "detection", timeoutMs: LLM_DETECTION_TIMEOUT_MS }, (signal) =>
          fetchAnthropicText(settings, prompt, signal)
        )
      : await runWithLlmConcurrency(settings, { priority: "detection", timeoutMs: LLM_DETECTION_TIMEOUT_MS }, (signal) =>
          fetchOpenAiCompatibleDetectionText(
            settings,
            "You extract vocabulary that would benefit from explanation. Do not explain, reason, analyze, or restate the task. Your entire response must be exactly one minified JSON object and nothing else.",
            prompt,
            signal
          )
        );

    console.info(
      `TermPop LLM detection raw response ${chunk.index + 1}/${chunks.length}`,
      {
        provider: settings.provider,
        model: settings.model || defaultModel(settings.provider),
        chunkStart: chunk.start,
        inputPreview: truncate(chunk.text, 500),
        rawContent: content
      }
    );

    let parsed: ParsedDetectedTerms;
    try {
      parsed = parseDetectedTerms(content, chunk.text, chunk.start);
    } catch (error) {
      console.error(
        `TermPop LLM detection parse failed ${chunk.index + 1}/${chunks.length}`,
        {
          error: error instanceof Error ? error.message : String(error),
          provider: settings.provider,
          model: settings.model || defaultModel(settings.provider),
          chunkStart: chunk.start,
          inputPreview: truncate(chunk.text, 1000),
          rawContent: content
        }
      );
      throw new Error(`LLM response was not valid JSON. Raw response: ${truncate(content.replace(/\s+/g, " ").trim(), 1000)}`);
    }
    const parsedTerms = parsed.terms;
    debug.rawCandidateCount = (debug.rawCandidateCount ?? 0) + parsed.debug.rawCandidateCount;
    debug.matchedCount = (debug.matchedCount ?? 0) + parsed.debug.matchedCount;
    debug.rejectedCount = (debug.rejectedCount ?? 0) + parsed.debug.rejectedCount;
    debug.unmatchedCount = (debug.unmatchedCount ?? 0) + parsed.debug.unmatchedCount;
    debug.sampleCandidates = [...debug.sampleCandidates ?? [], ...parsed.debug.sampleCandidates].slice(0, 12);
    debug.sampleMatchedTerms = [...debug.sampleMatchedTerms ?? [], ...parsed.debug.sampleMatchedTerms].slice(0, 12);
    console.info(
      `TermPop LLM detection chunk ${chunk.index + 1}/${chunks.length}: ${parsedTerms.length} matched terms`,
      parsedTerms.map((term) => term.term)
    );
    terms.push(...parsedTerms);
  }

  const dedupedTerms = dedupeDetectedTerms(terms);
  debug.matchedCount = dedupedTerms.length;
  debug.sampleMatchedTerms = dedupedTerms.map((term) => term.term).slice(0, 12);
  return { terms: dedupedTerms, debug };
}

async function fetchOpenAiCompatibleDetectionText(settings: LlmSettings, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.1),
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = await response.json();
  const content = extractOpenAiCompatibleAnswerText(payload);
  return content;
}

async function runWithLlmConcurrency<T>(
  settings: LlmSettings,
  options: LlmRunOptions,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: number | undefined;

  if (options.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => controller.abort(new Error("LLM request timed out.")), options.timeoutMs);
  }

  await acquireLlmSlot(settings, options.priority, controller.signal);
  try {
    return await task(controller.signal);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    releaseLlmSlot(options.priority);
  }
}

async function acquireLlmSlot(settings: LlmSettings, priority: LlmPriority, signal: AbortSignal): Promise<void> {
  const limit = normalizeConcurrency(settings.maxConcurrency);
  const maxActiveRequests = maxActiveRequestsForPriority(priority, limit);
  if (activeRequestsForPriority(priority) < maxActiveRequests) {
    incrementActiveRequests(priority);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let entry: LlmQueueEntry;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      removeQueuedEntry(entry);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("LLM request was cancelled."));
    };

    entry = {
      signal,
      priority,
      maxActiveRequests,
      start: () => {
        cleanup();
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("LLM request was cancelled."));
          scheduleNextLlmRequest();
          return;
        }
        incrementActiveRequests(priority);
        resolve();
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    queueForPriority(priority).push(entry);
  });
}

function scheduleNextLlmRequest(): void {
  const next = takeStartableEntry(explanationQueue) ?? takeStartableEntry(detectionQueue);
  if (next) {
    next.start();
  }
}

function takeStartableEntry(queue: LlmQueueEntry[]): LlmQueueEntry | undefined {
  const index = queue.findIndex((entry) => activeRequestsForPriority(entry.priority) < entry.maxActiveRequests);
  if (index < 0) {
    return undefined;
  }

  const [entry] = queue.splice(index, 1);
  return entry;
}

function removeQueuedEntry(entry: LlmQueueEntry): void {
  removeFromQueue(explanationQueue, entry);
  removeFromQueue(detectionQueue, entry);
}

function removeFromQueue(queue: LlmQueueEntry[], entry: LlmQueueEntry): void {
  const index = queue.indexOf(entry);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function queueForPriority(priority: LlmPriority): LlmQueueEntry[] {
  return priority === "explanation" ? explanationQueue : detectionQueue;
}

function maxActiveRequestsForPriority(priority: LlmPriority, limit: number): number {
  if (priority === "explanation") {
    return limit;
  }

  return Math.max(limit - 1, 1);
}

function releaseLlmSlot(priority: LlmPriority): void {
  decrementActiveRequests(priority);
  scheduleNextLlmRequest();
}

function activeRequestsForPriority(priority: LlmPriority): number {
  return priority === "explanation" ? activeExplanationRequests : activeDetectionRequests;
}

function incrementActiveRequests(priority: LlmPriority): void {
  if (priority === "explanation") {
    activeExplanationRequests += 1;
    return;
  }

  activeDetectionRequests += 1;
}

function decrementActiveRequests(priority: LlmPriority): void {
  if (priority === "explanation") {
    activeExplanationRequests = Math.max(0, activeExplanationRequests - 1);
    return;
  }

  activeDetectionRequests = Math.max(0, activeDetectionRequests - 1);
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(Math.round(value), 1);
}

async function fetchAnthropicText(settings: LlmSettings, prompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.1),
      system: `${languageInstruction(settings.language)} You extract vocabulary that would benefit from explanation. Do not explain, reason, analyze, or restate the task. Your entire response must be exactly one minified JSON object and nothing else.`,
      messages: [{ role: "user", content: prompt }]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find((part) => part.type === "text")?.text;
  if (!content) {
    throw new Error(`LLM response did not include text content. Raw response: ${truncate(JSON.stringify(payload), 500)}`);
  }
  return content;
}

function buildTermExtractionPrompt(text: string, language: ExplanationLanguage, chunkNumber: number, totalChunks: number): string {
  return [
    languageInstruction(language),
    `From text segment ${chunkNumber}/${totalChunks} below, identify terms that a reader may want explained in context.`,
    "Prefer domain-specific nouns, file names, commands, APIs, acronyms, product names, framework names, and proper nouns.",
    "Do not include ordinary function words, full sentences, generic academic words, or common task nouns.",
    "Reject simple context words such as task, tasks, data, model, models, result, results, best, English, French, and German unless they are part of a longer domain-specific phrase.",
    "Each term must be an exact substring copied from the text with the same casing and punctuation.",
    "Return JSON only in this shape:",
    "{\"terms\":[{\"term\":\"exact text\",\"term_type\":\"Tech|Brand|Person|Place|Acronym|Custom\",\"confidence\":0.0}]}",
    "",
    `Text: ${text}`
  ].join("\n");
}

function parseDetectedTerms(content: string, sourceText: string, sourceOffset = 0): ParsedDetectedTerms {
  const parsed = JSON.parse(extractJsonPayload(content)) as unknown;
  const candidates = normalizeDetectedTermCandidates(parsed);
  const results: DetectedTerm[] = [];
  const occupied = new Set<string>();
  let rejected = 0;
  let unmatched = 0;
  const sampleCandidates: string[] = [];

  for (const candidate of candidates) {
    const rawTerm = String(candidate.term ?? "").trim();
    if (rawTerm && sampleCandidates.length < 12) {
      sampleCandidates.push(rawTerm);
    }
    if (!rawTerm || rawTerm.length > 80 || isRejectedLlmSimpleTerm(rawTerm)) {
      rejected += 1;
      continue;
    }

    const termType = normalizeTermType(candidate.term_type ?? candidate.type ?? candidate.category);
    const confidence = normalizeConfidence(candidate.confidence);
    const matches = findAllowedOccurrences(sourceText, rawTerm);
    const resolvedMatches = matches.length > 0 ? matches : findAllowedOccurrencesIgnoreCase(sourceText, rawTerm);
    if (resolvedMatches.length === 0) {
      unmatched += 1;
      continue;
    }
    for (const [start, end] of resolvedMatches) {
      const key = `${start}:${end}`;
      if (occupied.has(key)) {
        continue;
      }
      occupied.add(key);
      results.push({
        term: sourceText.slice(start, end),
        start: sourceOffset + start,
        end: sourceOffset + end,
        term_type: termType,
        confidence,
        source: "Ner"
      });
    }
  }

  console.info(
    `TermPop LLM detection parsed ${candidates.length} candidates, matched ${results.length}, rejected ${rejected}, unmatched ${unmatched}`,
    candidates.map((candidate) => candidate.term).filter(Boolean).slice(0, 20)
  );
  const terms = dedupeDetectedTerms(results);
  return {
    terms,
    debug: {
      rawCandidateCount: candidates.length,
      matchedCount: terms.length,
      rejectedCount: rejected,
      unmatchedCount: unmatched,
      sampleCandidates,
      sampleMatchedTerms: terms.map((term) => term.term).slice(0, 12)
    }
  };
}

function normalizeDetectedTermCandidates(parsed: unknown): DetectedTermCandidate[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap(normalizeDetectedTermCandidate);
  }

  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const singleCandidate = normalizeDetectedTermCandidate(object);
    if (singleCandidate.length > 0) {
      return singleCandidate;
    }

    for (const value of [
      object.terms,
      object.data,
      object.result,
      object.results,
      object.vocabulary,
      object.keywords,
      object.items,
      object.entities
    ]) {
      if (Array.isArray(value)) {
        return value.flatMap(normalizeDetectedTermCandidate);
      }
    }
  }

  return [];
}

function normalizeDetectedTermCandidate(value: unknown): DetectedTermCandidate[] {
  if (typeof value === "string") {
    return [{ term: value }];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const object = value as Record<string, unknown>;
  const term = object.term
    ?? object.text
    ?? object.word
    ?? object.name
    ?? object.label
    ?? object.phrase
    ?? object.keyword
    ?? object.entity
    ?? object.vocabulary;

  if (typeof term !== "string") {
    return [];
  }

  return [{
    term,
    term_type: object.term_type ?? object.type ?? object.category,
    type: object.type,
    category: object.category,
    confidence: object.confidence ?? object.score
  }];
}

function splitTextForLlmDetection(text: string): Array<{ text: string; start: number; index: number }> {
  const chunks: Array<{ text: string; start: number; index: number }> = [];
  let start = 0;

  while (start < text.length) {
    const end = findLlmChunkEnd(text, start);
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      const leadingWhitespace = text.slice(start, end).length - text.slice(start, end).trimStart().length;
      chunks.push({
        text: chunkText,
        start: start + leadingWhitespace,
        index: chunks.length
      });
    }

    if (end >= text.length) {
      break;
    }
    start = Math.max(end - LLM_DETECTION_CHUNK_OVERLAP, start + 1);
  }

  return chunks;
}

function findLlmChunkEnd(text: string, start: number): number {
  const target = Math.min(start + LLM_DETECTION_CHUNK_SIZE, text.length);
  if (target >= text.length) {
    return text.length;
  }

  const softBreak = Math.max(
    text.lastIndexOf("\n", target),
    text.lastIndexOf(". ", target),
    text.lastIndexOf("。", target),
    text.lastIndexOf("; ", target)
  );
  if (softBreak > start + Math.floor(LLM_DETECTION_CHUNK_SIZE * 0.6)) {
    return softBreak + 1;
  }

  const space = text.lastIndexOf(" ", target);
  if (space > start + Math.floor(LLM_DETECTION_CHUNK_SIZE * 0.6)) {
    return space + 1;
  }

  return target;
}

function isRejectedLlmSimpleTerm(term: string): boolean {
  const normalized = term.trim().toLocaleLowerCase();
  if (LLM_REJECTED_SIMPLE_TERMS.has(normalized)) {
    return true;
  }

  return /^[a-z]+$/i.test(term)
    && term.length <= 7
    && LLM_REJECTED_SIMPLE_TERMS.has(normalized.replace(/s$/, ""));
}

function mergePrimaryThenLlmTerms(primaryTerms: DetectedTerm[], llmTerms: DetectedTerm[]): DetectedTerm[] {
  const merged = [...primaryTerms];
  for (const term of llmTerms) {
    if (!merged.some((existing) => rangesOverlap(existing.start, existing.end, term.start, term.end))) {
      merged.push(term);
    }
  }

  return merged.sort((left, right) => left.start - right.start || sourcePriority(left) - sourcePriority(right) || right.confidence - left.confidence);
}

function sourcePriority(term: DetectedTerm): number {
  if (term.source === "Rule" || term.source === "Dictionary" || term.source === "User") {
    return 0;
  }
  return 1;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function rustDetect(text: string): DetectedTerm[] {
  return (JSON.parse(detect_terms_json(text)) as DetectedTerm[]).map((term) => ({
    ...term,
    start: byteOffsetToJsIndex(text, term.start),
    end: byteOffsetToJsIndex(text, term.end)
  }));
}

function dedupeDetectedTerms(terms: DetectedTerm[]): DetectedTerm[] {
  return terms
    .filter((term) => term.start < term.end)
    .sort((left, right) => left.start - right.start || right.confidence - left.confidence)
    .filter((term, index, sorted) => {
      const previous = sorted[index - 1];
      return !previous || !(previous.start < term.end && term.start < previous.end);
    });
}

function normalizeTermType(value: unknown): TermType {
  const text = String(value ?? "");
  if (["Tech", "Brand", "Person", "Place", "Acronym", "Custom"].includes(text)) {
    return text as TermType;
  }
  return "Custom";
}

function normalizeDetectionSource(value: unknown): "Rule" | "Dictionary" | "Ner" | "User" {
  const text = String(value ?? "");
  if (["Rule", "Dictionary", "Ner", "User"].includes(text)) {
    return text as "Rule" | "Dictionary" | "Ner" | "User";
  }
  return "Dictionary";
}

function normalizeConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.75;
  }
  return Math.min(Math.max(number, 0), 1);
}

function byteOffsetToJsIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  let jsIndex = 0;

  for (const char of text) {
    if (bytes >= byteOffset) {
      return jsIndex;
    }

    bytes += utf8ByteLength(char);
    jsIndex += char.length;
  }

  return text.length;
}

function utf8ByteLength(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function buildExplanationSystemPrompt(language: ExplanationLanguage, includeUsageExample: boolean): string {
  return [
    languageInstruction(language),
    "You explain vocabulary for readers.",
    explanationJsonShapeInstruction(includeUsageExample),
    "related_terms must be an array of 3 to 5 short strings. source_url may be null.",
    "The explanation must fit the provided context, not just the term's generic meaning."
  ].join(" ");
}

function buildPrompt(term: string, context: string | undefined, language: ExplanationLanguage, includeUsageExample: boolean): string {
  return [
    languageInstruction(language),
    `Term: ${term}`,
    `Context: ${context?.trim() || "(none)"}`,
    "",
    "Explain the term in the same language as the surrounding context when possible.",
    "definition: 1-2 concise sentences.",
    "category: short noun phrase.",
    "related_terms: 3-5 related terms.",
    usageExamplePromptLine(includeUsageExample),
    "source_url: null unless you are certain of a canonical source."
  ].join("\n");
}

function explanationJsonShapeInstruction(includeUsageExample: boolean): string {
  return includeUsageExample
    ? "Return strict JSON only, with keys: term, definition, category, related_terms, usage_example, source_url."
    : "Return strict JSON only, with keys: term, definition, category, related_terms, source_url. Do not include usage_example.";
}

function usageExamplePromptLine(includeUsageExample: boolean): string {
  return includeUsageExample
    ? "usage_example: one short usage scenario."
    : "Do not generate an example sentence or usage scenario.";
}

function languageInstruction(language: ExplanationLanguage): string {
  if (language === "zh-CN") {
    return "Output language: Simplified Chinese. Use natural, concise Chinese for all returned fields.";
  }
  if (language === "en") {
    return "Output language: English. Use natural, concise English for all returned fields.";
  }
  return "Output language: follow the surrounding context language. If the context is primarily Chinese, answer in Simplified Chinese; otherwise answer in the context language.";
}

function parseExplanation(content: string, fallbackTerm: string, includeUsageExample: boolean): Explanation {
  try {
    const jsonText = extractJsonObject(content);
    const parsed = JSON.parse(jsonText) as Partial<Explanation>;
    return {
      term: String(parsed.term || fallbackTerm),
      definition: String(parsed.definition || ""),
      category: String(parsed.category || "General concept"),
      related_terms: Array.isArray(parsed.related_terms) ? parsed.related_terms.map(String).slice(0, 5) : [],
      usage_example: includeUsageExample && parsed.usage_example ? String(parsed.usage_example) : null,
      source_url: parsed.source_url ? String(parsed.source_url) : null
    };
  } catch {
    return {
      term: fallbackTerm,
      definition: cleanupPlainTextExplanation(content, fallbackTerm),
      category: "LLM explanation",
      related_terms: [],
      usage_example: null,
      source_url: null
    };
  }
}

function extractOpenAiCompatibleText(payload: unknown): string {
  const data = payload as {
    choices?: Array<{
      message?: {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
      };
      text?: unknown;
    }>;
  };
  const choice = data.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.text
  ];

  for (const candidate of candidates) {
    const text = stringifyProviderText(candidate).trim();
    if (text) {
      return text;
    }
  }

  throw new Error(`LLM response did not include usable text. Raw response: ${truncate(JSON.stringify(payload), 500)}`);
}

function extractOpenAiCompatibleAnswerText(payload: unknown): string {
  const data = payload as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
      text?: unknown;
    }>;
  };
  const choice = data.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.text
  ];

  for (const candidate of candidates) {
    const text = stringifyProviderText(candidate).trim();
    if (text) {
      return text;
    }
  }

  throw new Error(`LLM response did not include final answer content. Raw response: ${truncate(JSON.stringify(payload), 1000)}`);
}

function stringifyProviderText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function cleanupPlainTextExplanation(content: string, term: string): string {
  const normalized = content
    .replace(/\s+/g, " ")
    .replace(/^got it[,，]?\s*/i, "")
    .trim();
  const termIndex = normalized.toLowerCase().indexOf(term.toLowerCase());
  const useful = termIndex > 120 ? normalized.slice(termIndex) : normalized;
  return truncate(useful || content.trim(), 700);
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("LLM response was not valid JSON.");
}

function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  if (isParseableJson(trimmed)) {
    return trimmed;
  }

  const objectCandidate = findParseableJsonCandidate(trimmed, "{", "}");
  if (objectCandidate) {
    return objectCandidate;
  }

  const arrayCandidate = findParseableJsonCandidate(trimmed, "[", "]");
  if (arrayCandidate) {
    return arrayCandidate;
  }

  throw new Error("LLM response was not valid JSON.");
}

function findParseableJsonCandidate(text: string, open: "{" | "[", close: "}" | "]"): string | undefined {
  for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + 1)) {
    const end = findMatchingJsonEnd(text, start, open, close);
    if (end < 0) {
      continue;
    }

    const candidate = text.slice(start, end + 1);
    if (isParseableJson(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function findMatchingJsonEnd(text: string, start: number, open: "{" | "[", close: "}" | "]"): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === open) {
      depth += 1;
      continue;
    }

    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isParseableJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

async function formatProviderError(response: Response): Promise<string> {
  const text = await response.text();
  const fallback = providerErrorFallback(response);
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    const message = (json.error?.message || json.message || "").trim();
    if (message && message.toLowerCase() !== "unauthorized") {
      return message;
    }
    return fallback;
  } catch {
    const message = text.trim();
    if (message && message.toLowerCase() !== "unauthorized") {
      return message;
    }
    return fallback;
  }
}

function providerErrorFallback(response: Response): string {
  if (response.status === 401) {
    return "LLM API 授权失败，请检查插件设置里的 API Key、Base URL 和模型。";
  }
  if (response.status === 403) {
    return "LLM API 拒绝访问，请检查 API Key 权限或账号状态。";
  }
  if (response.status === 429) {
    return "LLM API 请求过于频繁，请稍后再试。";
  }
  return `LLM API 请求失败：${response.status} ${response.statusText}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeCacheTerm(term: string): string {
  return term.trim().toLocaleLowerCase();
}

function isExplanation(value: unknown): value is Explanation {
  if (!value || typeof value !== "object") {
    return false;
  }

  const explanation = value as Partial<Explanation>;
  return typeof explanation.term === "string"
    && typeof explanation.definition === "string"
    && typeof explanation.category === "string"
    && Array.isArray(explanation.related_terms);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function defaultBaseUrl(provider: string): string {
  if (provider === "kimi") {
    return "https://api.moonshot.cn/v1";
  }
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function defaultModel(provider: string): string {
  if (provider === "kimi") {
    return "moonshot-v1-8k";
  }
  if (provider === "anthropic") {
    return "claude-3-5-haiku-latest";
  }
  return "gpt-4.1-mini";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
