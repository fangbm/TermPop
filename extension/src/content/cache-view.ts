import { domainFromUrl } from "../shared/browser-utils.ts";
import type { CachedTermEntry, CacheScope, DetectedTerm } from "../shared/types.ts";

export interface CacheViewContext {
  url?: string;
  pageFingerprint?: string;
}

export function isCachedTermAvailable(entry: CachedTermEntry, context: CacheViewContext): boolean {
  if (entry.scope === "global") {
    return true;
  }
  if (entry.scope === "domain") {
    return Boolean(entry.domain && entry.domain === domainFromUrl(context.url));
  }
  return Boolean(entry.page_fingerprint && entry.page_fingerprint === context.pageFingerprint);
}

export function mergeCachedTermView(
  current: CachedTermEntry[],
  incoming: Array<CachedTermEntry | DetectedTerm>,
  context: CacheViewContext,
  now = Date.now()
): CachedTermEntry[] {
  const byKey = new Map(current.map((entry) => [cacheEntryKey(entry), entry]));

  for (const value of incoming) {
    const entry = isCachedTermEntry(value)
      ? normalizeCachedEntry(value, now)
      : cachedEntryFromDetectedTerm(value, context, now);
    const normalizedTerm = normalizeTerm(entry.term);
    if (normalizedTerm.length < 2 || entry.term.trim().length > 80) {
      continue;
    }

    const key = cacheEntryKey(entry);
    const existing = byKey.get(key);
    if (!existing || entry.confidence >= existing.confidence) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()];
}

function cachedEntryFromDetectedTerm(term: DetectedTerm, context: CacheViewContext, now: number): CachedTermEntry {
  const scope = writableScope(defaultScopeForTerm(term), context);
  return {
    term: term.term.trim(),
    term_type: term.term_type,
    confidence: term.confidence,
    source: term.source,
    scope,
    domain: scope === "domain" ? domainFromUrl(context.url) ?? null : null,
    page_fingerprint: scope === "pageFingerprint" ? context.pageFingerprint ?? null : null,
    last_seen_at: now
  };
}

function normalizeCachedEntry(entry: CachedTermEntry, now: number): CachedTermEntry {
  return {
    ...entry,
    term: entry.term.trim(),
    domain: entry.scope === "domain" ? entry.domain ?? null : null,
    page_fingerprint: entry.scope === "pageFingerprint" ? entry.page_fingerprint ?? null : null,
    last_seen_at: entry.last_seen_at || now
  };
}

function defaultScopeForTerm(term: DetectedTerm): CacheScope {
  if (term.source === "Dictionary" || term.source === "Rule" || term.source === "User") {
    return "global";
  }
  return term.confidence < 0.82 ? "pageFingerprint" : "domain";
}

function writableScope(scope: CacheScope, context: CacheViewContext): CacheScope {
  if (scope === "pageFingerprint" && !context.pageFingerprint) {
    return domainFromUrl(context.url) ? "domain" : "global";
  }
  if (scope === "domain" && !domainFromUrl(context.url)) {
    return "global";
  }
  return scope;
}

function cacheEntryKey(entry: CachedTermEntry): string {
  return [
    entry.scope,
    entry.domain ?? "",
    entry.page_fingerprint ?? "",
    normalizeTerm(entry.term)
  ].join("\n");
}

function normalizeTerm(term: string): string {
  return term.trim().toLocaleLowerCase();
}

function isCachedTermEntry(value: CachedTermEntry | DetectedTerm): value is CachedTermEntry {
  return "scope" in value;
}
