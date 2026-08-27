const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TimedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export function buildDetectionCacheKey(parts: {
  detectionMode: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  temperature: number;
  maxTokens: number;
  promptInstruction?: string;
  dictionaryJson?: string;
  url?: string;
  pageFingerprint?: string;
  text: string;
}): string {
  return [
    parts.detectionMode,
    parts.provider,
    fingerprint(parts.apiKey),
    fingerprint(parts.baseUrl),
    parts.model,
    parts.language,
    String(parts.temperature),
    String(parts.maxTokens),
    fingerprint(parts.promptInstruction ?? "default-detection-prompt"),
    fingerprint(parts.dictionaryJson ?? ""),
    fingerprint(parts.url ?? ""),
    fingerprint(parts.pageFingerprint || parts.text.slice(0, 1_200)),
    fingerprint(parts.text),
    parts.text.length
  ].join("\n");
}

export function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
