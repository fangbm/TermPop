import type { Explanation } from "../shared/types";

export interface ExplanationCacheEntryLike {
  key: string;
  last_used_at: number;
}

export function utf8ByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}

export function serializedEntriesByteSize<T>(entries: T[]): number {
  return utf8ByteSize(entries);
}

export function canUseCachedExplanation(explanation: Explanation): boolean {
  return explanation.provider_status === "llm";
}

export function pruneEntriesToByteBudget<T extends ExplanationCacheEntryLike>(entries: T[], maxEntries: number, maxBytes: number): T[] {
  const sorted = [...entries].sort((left, right) => right.last_used_at - left.last_used_at);
  const kept: T[] = [];
  let bytes = 2;

  for (const entry of sorted) {
    if (kept.length >= maxEntries) {
      break;
    }
    const entryBytes = utf8ByteSize(entry) + (kept.length > 0 ? 1 : 0);
    if (bytes + entryBytes > maxBytes) {
      continue;
    }
    kept.push(entry);
    bytes += entryBytes;
  }

  return kept;
}
