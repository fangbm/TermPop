import { filterAllowedDetectedTerms, findAllowedOccurrences, findAllowedOccurrencesIgnoreCase } from "../shared/term-matching";
import type { DetectTermsDebug, DetectedTerm, LlmSettings, TermType } from "../shared/types";
import { addCachedTerms, detectCachedTerms } from "./cache";
import { extractJsonPayload } from "./json";
import { createLlmProvider } from "./llm-provider";
import { buildTermExtractionPrompt, buildTermExtractionSystemPrompt } from "./prompts";
import { debugLog, defaultBaseUrl, defaultModel, sanitizeForLog } from "./utils";
import { detectWithWasm } from "./wasm-runtime";

const detectionCache = new Map<string, DetectedTerm[]>();
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

export async function detectTerms(
  text: string,
  detectionMode: "primary" | "llm" | "all",
  settings: { llm: LlmSettings; dictionaryJson?: string },
  cacheContext: { url?: string; pageFingerprint?: string } = {}
): Promise<DetectionResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { terms: [] };
  }

  const cacheKey = [
    detectionMode,
    settings.llm.provider,
    settings.llm.baseUrl || defaultBaseUrl(settings.llm.provider),
    settings.llm.model || defaultModel(settings.llm.provider),
    settings.llm.language,
    settings.dictionaryJson ?? "",
    cacheContext.url ?? "",
    cacheContext.pageFingerprint ?? "",
    text
  ].join("\n");
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    return { terms: cached };
  }

  const primaryTerms = dedupeDetectedTerms(filterAllowedDetectedTerms(text, [
    ...(await rustDetect(text, settings.dictionaryJson)),
    ...(await detectCachedTerms(text, cacheContext))
  ]));
  if (detectionMode === "primary") {
    detectionCache.set(cacheKey, primaryTerms);
    return { terms: primaryTerms };
  }

  let llmTerms: DetectedTerm[] = [];
  let llmDebug: DetectTermsDebug | undefined;
  if (settings.llm.provider !== "mock" && settings.llm.apiKey.trim()) {
    try {
      const result = await fetchLlmDetectedTerms(text, settings.llm, primaryTerms);
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
    void addCachedTerms(llmTerms, cacheContext);
    return { terms: llmTerms, debug: { ...llmDebug, matchedCount: llmTerms.length } };
  }

  const terms = mergePrimaryThenLlmTerms(
    primaryTerms,
    dedupeDetectedTerms(filterAllowedDetectedTerms(text, llmTerms))
  );
  void addCachedTerms(terms, cacheContext);
  detectionCache.set(cacheKey, terms);
  return { terms, debug: llmDebug };
}

async function fetchLlmDetectedTerms(text: string, settings: LlmSettings, primaryTerms: DetectedTerm[]): Promise<DetectionResult> {
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
  const provider = createLlmProvider(settings);
  const system = buildTermExtractionSystemPrompt(settings.language);

  for (const chunk of chunks) {
    const prompt = buildTermExtractionPrompt(chunk.text, settings.language, chunk.index + 1, chunks.length);
    const content = await provider.detectTerms(prompt, system, settings, LLM_DETECTION_TIMEOUT_MS);

    debugLog(`TermPop LLM detection raw response ${chunk.index + 1}/${chunks.length}`, {
      provider: settings.provider,
      model: settings.model || defaultModel(settings.provider),
      chunkStart: chunk.start,
      inputPreview: sanitizeForLog(chunk.text, 300),
      rawPreview: sanitizeForLog(content, 500)
    });

    let parsed: ParsedDetectedTerms;
    try {
      parsed = parseDetectedTerms(content, chunk.text, chunk.start, text, primaryTerms);
    } catch (error) {
      debugLog(`TermPop LLM detection parse failed ${chunk.index + 1}/${chunks.length}`, {
        error: error instanceof Error ? error.message : String(error),
        provider: settings.provider,
        model: settings.model || defaultModel(settings.provider),
        chunkStart: chunk.start,
        inputPreview: sanitizeForLog(chunk.text, 500),
        rawPreview: sanitizeForLog(content, 500)
      });
      throw new Error("LLM response was not valid JSON.");
    }
    const parsedTerms = parsed.terms;
    debug.rawCandidateCount = (debug.rawCandidateCount ?? 0) + parsed.debug.rawCandidateCount;
    debug.matchedCount = (debug.matchedCount ?? 0) + parsed.debug.matchedCount;
    debug.rejectedCount = (debug.rejectedCount ?? 0) + parsed.debug.rejectedCount;
    debug.unmatchedCount = (debug.unmatchedCount ?? 0) + parsed.debug.unmatchedCount;
    debug.sampleCandidates = [...debug.sampleCandidates ?? [], ...parsed.debug.sampleCandidates].slice(0, 12);
    debug.sampleMatchedTerms = [...debug.sampleMatchedTerms ?? [], ...parsed.debug.sampleMatchedTerms].slice(0, 12);
    debugLog(
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

function parseDetectedTerms(content: string, sourceText: string, sourceOffset: number, fullText: string, primaryTerms: DetectedTerm[]): ParsedDetectedTerms {
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
    const rawConfidence = normalizeConfidence(candidate.confidence);
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
      const termText = sourceText.slice(start, end);
      results.push({
        term: termText,
        start: sourceOffset + start,
        end: sourceOffset + end,
        term_type: termType,
        confidence: calibrateLlmConfidence(termText, rawConfidence, fullText, primaryTerms),
        source: "Ner"
      });
    }
  }

  debugLog(
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

function calibrateLlmConfidence(term: string, confidence: number, fullText: string, primaryTerms: DetectedTerm[]): number {
  let adjusted = confidence;
  const normalized = term.trim().toLocaleLowerCase();
  if (/^[a-z]+$/i.test(term) && term.length <= 4) {
    adjusted -= 0.08;
  }
  if (/^[a-z]+$/i.test(term) && term.length <= 7) {
    adjusted -= 0.04;
  }
  if (primaryTerms.some((primary) => primary.term.trim().toLocaleLowerCase() === normalized)) {
    adjusted += 0.08;
  }
  if (countOccurrencesIgnoreCase(fullText, term) >= 2) {
    adjusted += 0.04;
  }
  return Math.min(0.99, Math.max(0.2, Number(adjusted.toFixed(3))));
}

function countOccurrencesIgnoreCase(text: string, term: string): number {
  if (!term.trim()) {
    return 0;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = /^[A-Za-z0-9_./+-]+$/.test(term) ? new RegExp(`\\b${escaped}\\b`, "gi") : new RegExp(escaped, "gi");
  return [...text.matchAll(pattern)].length;
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

async function rustDetect(text: string, dictionaryJson: string | undefined): Promise<DetectedTerm[]> {
  const raw = await detectWithWasm(text, dictionaryJson);
  const parsed = JSON.parse(raw) as Array<DetectedTerm & { start: number; end: number }>;
  return parsed.map((term) => ({
    term: term.term,
    start: byteOffsetToJsIndex(text, term.start),
    end: byteOffsetToJsIndex(text, term.end),
    term_type: normalizeTermType(term.term_type),
    confidence: normalizeConfidence(term.confidence),
    source: normalizeDetectionSource(term.source)
  }));
}

function dedupeDetectedTerms(terms: DetectedTerm[]): DetectedTerm[] {
  return [...terms]
    .sort((left, right) => left.start - right.start || right.confidence - left.confidence || (right.end - right.start) - (left.end - left.start))
    .reduce<DetectedTerm[]>((kept, term) => {
      if (kept.some((existing) => rangesOverlap(existing.start, existing.end, term.start, term.end))) {
        return kept;
      }
      kept.push(term);
      return kept;
    }, []);
}

function normalizeTermType(value: unknown): TermType {
  if (value === "Tech" || value === "Brand" || value === "Person" || value === "Place" || value === "Acronym" || value === "Custom") {
    return value;
  }
  return "Custom";
}

function normalizeDetectionSource(value: unknown): "Rule" | "Dictionary" | "Ner" | "User" {
  if (value === "Rule" || value === "Dictionary" || value === "Ner" || value === "User") {
    return value;
  }
  return "Dictionary";
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }
  return 0.75;
}

function byteOffsetToJsIndex(text: string, byteOffset: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes >= byteOffset) {
      return index;
    }
    bytes += utf8ByteLength(text[index]);
  }
  return text.length;
}

function utf8ByteLength(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}
