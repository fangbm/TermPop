import initWasm, { detect_terms_json, explain_term_json } from "../wasm/termlens_core.js";
import { getSettings } from "../shared/settings";
import type {
  AddCachedTermsRequest,
  AddCachedTermsResponse,
  CachedTermEntry,
  DetectTermsRequest,
  DetectTermsResponse,
  DetectedTerm,
  ExplanationLanguage,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  ExplainRequest,
  ExplainResponse,
  Explanation,
  LlmSettings,
  TermType
} from "../shared/types";

const explanationCache = new Map<string, Explanation>();
const detectionCache = new Map<string, DetectedTerm[]>();
const wasmReady = initWasm({ module_or_path: chrome.runtime.getURL("assets/termlens_core_bg.wasm") });
const GLOBAL_TERM_CACHE_KEY = "termlens.globalTermCache";
const MAX_GLOBAL_CACHED_TERMS = 3000;
const LLM_DETECTION_TIMEOUT_MS = 8000;
let activeLlmRequests = 0;
let globalTermCache: Map<string, CachedTermEntry> | undefined;
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
  maxActiveRequests: number;
}

chrome.runtime.onMessage.addListener(
  (message: ExplainRequest | DetectTermsRequest | GetCachedTermsRequest | AddCachedTermsRequest, _sender, sendResponse) => {
  if (message.type === "TERMLENS_GET_CACHED_TERMS") {
    getCachedTerms()
      .then((terms) => sendResponse({ ok: true, terms } satisfies GetCachedTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies GetCachedTermsResponse);
      });
    return true;
  }

  if (message.type === "TERMLENS_ADD_CACHED_TERMS") {
    addGlobalCachedTerms(message.terms)
      .then(() => sendResponse({ ok: true } satisfies AddCachedTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies AddCachedTermsResponse);
      });
    return true;
  }

  if (message.type === "TERMLENS_DETECT_TERMS") {
    detectTerms(message.text)
      .then((terms) => sendResponse({ ok: true, terms } satisfies DetectTermsResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies DetectTermsResponse);
      });
    return true;
  }

  if (message.type !== "TERMLENS_EXPLAIN") {
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

async function detectTerms(text: string): Promise<DetectedTerm[]> {
  await wasmReady;
  const settings = await getSettings();
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const cacheKey = `${settings.llm.provider}\n${settings.llm.baseUrl}\n${settings.llm.model}\n${settings.llm.language}\n${text}`;
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const cachedTerms = await detectGlobalCachedTerms(text);
  let terms: DetectedTerm[];
  if (settings.llm.provider === "mock" || !settings.llm.apiKey.trim()) {
    terms = rustDetect(text);
  } else {
    try {
      terms = await fetchLlmDetectedTerms(text, settings.llm);
      if (terms.length === 0) {
        terms = rustDetect(text);
      }
    } catch {
      terms = rustDetect(text);
    }
  }

  terms = dedupeDetectedTerms([...terms, ...cachedTerms]);
  void addGlobalCachedTerms(terms);
  detectionCache.set(cacheKey, terms);
  return terms;
}

async function getCachedTerms(): Promise<CachedTermEntry[]> {
  const cache = await loadGlobalTermCache();
  return [...cache.values()];
}

async function detectGlobalCachedTerms(text: string): Promise<DetectedTerm[]> {
  const cache = await loadGlobalTermCache();
  const terms: DetectedTerm[] = [];

  for (const entry of cache.values()) {
    for (const [start, end] of findAllOccurrences(text, entry.term)) {
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
  return trimmed.length >= 2 && trimmed.length <= 80 && normalized.length >= 2;
}

async function explain(term: string, context: string | undefined, cacheScope: string | undefined, refresh: boolean): Promise<Explanation> {
  await wasmReady;
  const settings = await getSettings();

  const normalizedTerm = normalizeCacheTerm(term);
  const scope = cacheScope || normalizedTerm;
  const cacheKey = `${settings.llm.provider}\n${settings.llm.baseUrl}\n${settings.llm.model}\n${settings.llm.language}\n${settings.llm.includeUsageExample}\n${scope}`;
  const cached = explanationCache.get(cacheKey);
  if (cached && !refresh) {
    return cached;
  }

  const explanation =
    settings.llm.provider === "mock" || !settings.llm.apiKey.trim()
      ? mockExplain(term, context, settings.llm.language, settings.llm.includeUsageExample)
      : await fetchLlmExplanation(term, context, settings.llm);

  explanationCache.set(cacheKey, explanation);
  return explanation;
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

async function fetchLlmDetectedTerms(text: string, settings: LlmSettings): Promise<DetectedTerm[]> {
  if (settings.provider === "anthropic") {
    const content = await runWithLlmConcurrency(settings, { priority: "detection", timeoutMs: LLM_DETECTION_TIMEOUT_MS }, (signal) =>
      fetchAnthropicText(settings, buildTermExtractionPrompt(text, settings.language), signal)
    );
    return parseDetectedTerms(content, text);
  }

  const content = await runWithLlmConcurrency(settings, { priority: "detection", timeoutMs: LLM_DETECTION_TIMEOUT_MS }, (signal) =>
    fetchOpenAiCompatibleText(
      settings,
      "You extract vocabulary that would benefit from explanation. Return strict JSON only.",
      buildTermExtractionPrompt(text, settings.language),
      signal
    )
  );
  return parseDetectedTerms(content, text);
}

async function fetchOpenAiCompatibleText(settings: LlmSettings, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.3),
      max_tokens: Math.max(settings.maxTokens, 450),
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
  const content = extractOpenAiCompatibleText(payload);
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
    releaseLlmSlot();
  }
}

async function acquireLlmSlot(settings: LlmSettings, priority: LlmPriority, signal: AbortSignal): Promise<void> {
  const limit = normalizeConcurrency(settings.maxConcurrency);
  const maxActiveRequests = maxActiveRequestsForPriority(priority, limit);
  if (activeLlmRequests < maxActiveRequests) {
    activeLlmRequests += 1;
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
      maxActiveRequests,
      start: () => {
        cleanup();
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : new Error("LLM request was cancelled."));
          scheduleNextLlmRequest();
          return;
        }
        activeLlmRequests += 1;
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
  const index = queue.findIndex((entry) => activeLlmRequests < entry.maxActiveRequests);
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

function releaseLlmSlot(): void {
  activeLlmRequests = Math.max(0, activeLlmRequests - 1);
  scheduleNextLlmRequest();
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
      max_tokens: Math.max(settings.maxTokens, 450),
      temperature: Math.min(settings.temperature, 0.3),
      system: `${languageInstruction(settings.language)} You extract vocabulary that would benefit from explanation. Return strict JSON only.`,
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

function buildTermExtractionPrompt(text: string, language: ExplanationLanguage): string {
  return [
    languageInstruction(language),
    "From the text below, identify terms that a reader may want explained in context.",
    "Prefer domain-specific nouns, file names, commands, APIs, acronyms, product names, framework names, and proper nouns.",
    "Do not include ordinary function words or full sentences.",
    "Each term must be an exact substring of the text.",
    "Return JSON only in this shape:",
    "{\"terms\":[{\"term\":\"exact text\",\"term_type\":\"Tech|Brand|Person|Place|Acronym|Custom\",\"confidence\":0.0}]}",
    "",
    `Text: ${truncate(text, 1200)}`
  ].join("\n");
}

function parseDetectedTerms(content: string, sourceText: string): DetectedTerm[] {
  const parsed = JSON.parse(extractJsonObject(content)) as {
    terms?: Array<{ term?: unknown; term_type?: unknown; confidence?: unknown }>;
  };
  const candidates = parsed.terms ?? [];
  const results: DetectedTerm[] = [];
  const occupied = new Set<string>();

  for (const candidate of candidates) {
    const rawTerm = String(candidate.term ?? "").trim();
    if (!rawTerm || rawTerm.length > 80) {
      continue;
    }

    const termType = normalizeTermType(candidate.term_type);
    const confidence = normalizeConfidence(candidate.confidence);
    const matches = findAllOccurrences(sourceText, rawTerm);
    for (const [start, end] of matches) {
      const key = `${start}:${end}`;
      if (occupied.has(key)) {
        continue;
      }
      occupied.add(key);
      results.push({
        term: sourceText.slice(start, end),
        start,
        end,
        term_type: termType,
        confidence,
        source: "Ner"
      });
    }
  }

  return dedupeDetectedTerms(results);
}

function rustDetect(text: string): DetectedTerm[] {
  return (JSON.parse(detect_terms_json(text)) as DetectedTerm[]).map((term) => ({
    ...term,
    start: byteOffsetToJsIndex(text, term.start),
    end: byteOffsetToJsIndex(text, term.end)
  }));
}

function findAllOccurrences(text: string, term: string): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(term, from);
    if (index < 0) {
      break;
    }
    matches.push([index, index + term.length]);
    from = index + Math.max(term.length, 1);
  }
  return matches;
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

async function formatProviderError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message || json.message || `${response.status} ${response.statusText}`;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeCacheTerm(term: string): string {
  return term.trim().toLocaleLowerCase();
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
