import { findAllowedOccurrences } from "../shared/term-matching";
import type { CachedTermEntry, CacheScope, DetectedTerm, Explanation, LlmSettings, TermType } from "../shared/types";
import { domainFromUrl } from "../shared/browser-utils";
import { defaultBaseUrl, defaultModel, hashString, isExplanation, normalizeBaseUrl, normalizeCacheContext, normalizeCacheTerm } from "./utils";

const TERM_CACHE_KEY = "termpop.termCache";
const LEGACY_GLOBAL_TERM_CACHE_KEY = "termpop.globalTermCache";
const EXPLANATION_CACHE_KEY = "termpop.explanationCache";
const MAX_CACHED_TERMS = 5000;
const MAX_EXPLANATION_CACHE_ENTRIES = 5000;
const EXPLANATION_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

let termCache: Map<string, CachedTermEntry> | undefined;
let persistentExplanationCache: Map<string, CachedExplanationEntry> | undefined;

interface TermCacheContext {
  url?: string;
  pageFingerprint?: string;
}

interface CachedExplanationEntry {
  key: string;
  explanation: Explanation;
  created_at: number;
  last_used_at: number;
}

export async function getCachedTerms(context: TermCacheContext = {}): Promise<CachedTermEntry[]> {
  const cache = await loadTermCache();
  return [...cache.values()].filter((entry) => isEntryInScope(entry, context));
}

export async function detectCachedTerms(text: string, context: TermCacheContext = {}): Promise<DetectedTerm[]> {
  const cache = await loadTermCache();
  const terms: DetectedTerm[] = [];

  for (const entry of cache.values()) {
    if (!isEntryInScope(entry, context)) {
      continue;
    }
    if (!shouldCacheTerm(entry.term, normalizeCacheTerm(entry.term))) {
      continue;
    }
    for (const [start, end] of findAllowedOccurrences(text, entry.term)) {
      terms.push({
        term: text.slice(start, end),
        start,
        end,
        term_type: entry.term_type,
        confidence: Math.min(0.98, entry.confidence),
        source: entry.source
      });
    }
  }

  return terms;
}

export async function addCachedTerms(terms: DetectedTerm[], context: TermCacheContext = {}, requestedScope?: CacheScope): Promise<void> {
  if (terms.length === 0) {
    return;
  }

  const cache = await loadTermCache();
  const now = Date.now();
  let changed = false;

  for (const term of terms) {
    const normalized = normalizeCacheTerm(term.term);
    if (!shouldCacheTerm(term.term, normalized)) {
      continue;
    }

    const scope = normalizeWritableScope(requestedScope ?? defaultScopeForTerm(term), context);
    const domain = scope === "domain" ? domainFromUrl(context.url) ?? null : null;
    const pageFingerprint = scope === "pageFingerprint" ? context.pageFingerprint ?? null : null;
    const cacheKey = buildTermCacheKey(normalized, scope, domain, pageFingerprint);
    const existing = cache.get(cacheKey);
    if (!existing || existing.confidence < term.confidence) {
      cache.set(cacheKey, {
        term: term.term.trim(),
        term_type: term.term_type,
        confidence: term.confidence,
        source: term.source,
        scope,
        domain,
        page_fingerprint: pageFingerprint,
        last_seen_at: now,
        seen_count: (existing?.seen_count ?? 0) + 1
      });
      changed = true;
    } else {
      existing.last_seen_at = now;
      existing.seen_count = (existing.seen_count ?? 0) + 1;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  pruneTermCache(cache);
  await chrome.storage.local.set({
    [TERM_CACHE_KEY]: [...cache.values()]
  });
}

export async function getPersistentExplanation(cacheKey: string): Promise<Explanation | undefined> {
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

export async function setPersistentExplanation(cacheKey: string, explanation: Explanation): Promise<void> {
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

export function buildExplanationCacheKey(term: string, context: string | undefined, cacheScope: string | undefined, settings: LlmSettings): string {
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
    settings.includeUsageExample ? "usage" : "no-usage",
    scopeFingerprint,
    contextFingerprint,
    normalizedTerm
  ].join("\n");
}

async function loadTermCache(): Promise<Map<string, CachedTermEntry>> {
  if (termCache) {
    return termCache;
  }

  const stored = await chrome.storage.local.get([TERM_CACHE_KEY, LEGACY_GLOBAL_TERM_CACHE_KEY]);
  const modernEntries = Array.isArray(stored[TERM_CACHE_KEY])
    ? stored[TERM_CACHE_KEY] as Array<CachedTermEntry & { scope?: CacheScope }>
    : [];
  const legacyEntries = Array.isArray(stored[LEGACY_GLOBAL_TERM_CACHE_KEY])
    ? stored[LEGACY_GLOBAL_TERM_CACHE_KEY] as Array<CachedTermEntry & { scope?: CacheScope }>
    : [];
  const entries = modernEntries.length > 0 ? modernEntries : legacyEntries;

  termCache = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.term !== "string") {
      continue;
    }
    const normalized = normalizeCacheTerm(entry.term);
    if (!shouldCacheTerm(entry.term, normalized)) {
      continue;
    }
    const scope = normalizeStoredScope(entry.scope);
    const domain = scope === "domain" ? entry.domain ?? null : null;
    const pageFingerprint = scope === "pageFingerprint" ? entry.page_fingerprint ?? null : null;
    termCache.set(buildTermCacheKey(normalized, scope, domain, pageFingerprint), {
      term: entry.term,
      term_type: normalizeTermType(entry.term_type),
      confidence: typeof entry.confidence === "number" ? entry.confidence : 0.75,
      source: entry.source ?? "Dictionary",
      scope,
      domain,
      page_fingerprint: pageFingerprint,
      last_seen_at: typeof entry.last_seen_at === "number" ? entry.last_seen_at : 0,
      seen_count: typeof entry.seen_count === "number" ? entry.seen_count : 1
    });
  }

  pruneTermCache(termCache);
  if (modernEntries.length === 0 && legacyEntries.length > 0) {
    await chrome.storage.local.set({ [TERM_CACHE_KEY]: [...termCache.values()] });
  }
  return termCache;
}

function pruneTermCache(cache: Map<string, CachedTermEntry>): void {
  if (cache.size <= MAX_CACHED_TERMS) {
    return;
  }
  const keep = [...cache.values()]
    .sort((left, right) => (right.last_seen_at ?? 0) - (left.last_seen_at ?? 0) || (right.confidence ?? 0) - (left.confidence ?? 0))
    .slice(0, MAX_CACHED_TERMS);
  cache.clear();
  for (const entry of keep) {
    cache.set(buildTermCacheKey(normalizeCacheTerm(entry.term), entry.scope, entry.domain ?? null, entry.page_fingerprint ?? null), entry);
  }
}

function buildTermCacheKey(normalizedTerm: string, scope: CacheScope, domain: string | null, pageFingerprint: string | null): string {
  return [scope, domain ?? "", pageFingerprint ?? "", normalizedTerm].join("\n");
}

function isEntryInScope(entry: CachedTermEntry, context: TermCacheContext): boolean {
  if (entry.scope === "global") {
    return true;
  }
  if (entry.scope === "domain") {
    return Boolean(entry.domain && entry.domain === domainFromUrl(context.url));
  }
  return Boolean(entry.page_fingerprint && entry.page_fingerprint === context.pageFingerprint);
}

function defaultScopeForTerm(term: DetectedTerm): CacheScope {
  if (term.source === "Dictionary" || term.source === "Rule" || term.source === "User") {
    return "global";
  }
  return term.confidence < 0.82 ? "pageFingerprint" : "domain";
}

function normalizeWritableScope(scope: CacheScope, context: TermCacheContext): CacheScope {
  if (scope === "pageFingerprint" && !context.pageFingerprint) {
    return domainFromUrl(context.url) ? "domain" : "global";
  }
  if (scope === "domain" && !domainFromUrl(context.url)) {
    return "global";
  }
  return scope;
}

function normalizeStoredScope(value: CacheScope | undefined): CacheScope {
  return value === "domain" || value === "pageFingerprint" || value === "global" ? value : "global";
}

function shouldCacheTerm(term: string, normalized: string): boolean {
  if (!normalized || normalized.length < 2 || normalized.length > 80) {
    return false;
  }
  if (/^https?:\/\//i.test(term) || /^[\w.+-]+@[\w.-]+\.\w+$/i.test(term)) {
    return false;
  }
  return true;
}

async function loadPersistentExplanationCache(): Promise<Map<string, CachedExplanationEntry>> {
  if (persistentExplanationCache) {
    return persistentExplanationCache;
  }

  const stored = await chrome.storage.local.get(EXPLANATION_CACHE_KEY);
  const entries = Array.isArray(stored[EXPLANATION_CACHE_KEY])
    ? stored[EXPLANATION_CACHE_KEY] as CachedExplanationEntry[]
    : [];

  persistentExplanationCache = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string" || !isExplanation(entry.explanation)) {
      continue;
    }
    persistentExplanationCache.set(entry.key, {
      key: entry.key,
      explanation: entry.explanation,
      created_at: typeof entry.created_at === "number" ? entry.created_at : Date.now(),
      last_used_at: typeof entry.last_used_at === "number" ? entry.last_used_at : 0
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
    .sort((left, right) => right.last_used_at - left.last_used_at)
    .slice(0, MAX_EXPLANATION_CACHE_ENTRIES);
  cache.clear();
  for (const entry of keep) {
    cache.set(entry.key, entry);
  }
}

function normalizeTermType(value: unknown): TermType {
  if (value === "Tech" || value === "Brand" || value === "Person" || value === "Place" || value === "Acronym" || value === "Custom") {
    return value;
  }
  return "Custom";
}
