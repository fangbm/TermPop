import type { CachedTermEntry, DetectedTerm } from "./types";

export const IGNORED_TERMS_STORAGE_KEY = "termpop.ignoredTerms";
const MAX_IGNORED_TERMS = 2_000;

export interface IgnoredTermEntry {
  term: string;
  normalized: string;
  created_at: number;
}

export function normalizeIgnoredTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function parseIgnoredTerms(value: unknown): IgnoredTermEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const entries: IgnoredTermEntry[] = [];
  for (const item of value) {
    const rawTerm = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as { term?: unknown }).term === "string"
        ? (item as { term: string }).term
        : "";
    const normalized = normalizeIgnoredTerm(rawTerm);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push({
      term: rawTerm.trim(),
      normalized,
      created_at: item && typeof item === "object" && typeof (item as { created_at?: unknown }).created_at === "number"
        ? (item as { created_at: number }).created_at
        : 0
    });
  }
  return entries.slice(-MAX_IGNORED_TERMS);
}

export function ignoredTermSet(value: unknown): Set<string> {
  return new Set(parseIgnoredTerms(value).map((entry) => entry.normalized));
}

export function isIgnoredTerm(term: string, ignoredTerms: ReadonlySet<string>): boolean {
  return ignoredTerms.has(normalizeIgnoredTerm(term));
}

export function filterIgnoredDetectedTerms(terms: DetectedTerm[], ignoredTerms: ReadonlySet<string>): DetectedTerm[] {
  return terms.filter((term) => !isIgnoredTerm(term.term, ignoredTerms));
}

export function filterIgnoredCachedTerms(terms: CachedTermEntry[], ignoredTerms: ReadonlySet<string>): CachedTermEntry[] {
  return terms.filter((term) => !isIgnoredTerm(term.term, ignoredTerms));
}

export async function loadIgnoredTermSet(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(IGNORED_TERMS_STORAGE_KEY);
  return ignoredTermSet(stored[IGNORED_TERMS_STORAGE_KEY]);
}

export async function addIgnoredTerm(term: string): Promise<boolean> {
  const normalized = normalizeIgnoredTerm(term);
  if (!normalized) {
    return false;
  }
  const stored = await chrome.storage.local.get(IGNORED_TERMS_STORAGE_KEY);
  const entries = parseIgnoredTerms(stored[IGNORED_TERMS_STORAGE_KEY]);
  if (entries.some((entry) => entry.normalized === normalized)) {
    return false;
  }
  entries.push({ term: term.trim(), normalized, created_at: Date.now() });
  await chrome.storage.local.set({ [IGNORED_TERMS_STORAGE_KEY]: entries.slice(-MAX_IGNORED_TERMS) });
  return true;
}

export async function removeIgnoredTerm(term: string): Promise<boolean> {
  const normalized = normalizeIgnoredTerm(term);
  if (!normalized) {
    return false;
  }
  const stored = await chrome.storage.local.get(IGNORED_TERMS_STORAGE_KEY);
  const entries = parseIgnoredTerms(stored[IGNORED_TERMS_STORAGE_KEY]);
  const nextEntries = entries.filter((entry) => entry.normalized !== normalized);
  if (nextEntries.length === entries.length) {
    return false;
  }
  await chrome.storage.local.set({ [IGNORED_TERMS_STORAGE_KEY]: nextEntries });
  return true;
}

export async function clearIgnoredTerms(): Promise<void> {
  await chrome.storage.local.remove(IGNORED_TERMS_STORAGE_KEY);
}
