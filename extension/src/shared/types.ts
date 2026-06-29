export type TermType = "Tech" | "Brand" | "Person" | "Place" | "Acronym" | "Custom";
export type DetectionSource = "Rule" | "Dictionary" | "Ner" | "User";
export type TermPopMode = "hover" | "selection" | "hybrid";
export type LlmProvider = "mock" | "openai" | "kimi" | "openai-compatible" | "anthropic";
export type ExplanationLanguage = "auto" | "zh-CN" | "en";

export interface DetectedTerm {
  term: string;
  start: number;
  end: number;
  term_type: TermType;
  confidence: number;
  source: DetectionSource;
}

export interface CachedTermEntry {
  term: string;
  term_type: TermType;
  confidence: number;
  source: DetectionSource;
  last_seen_at: number;
}

export interface Explanation {
  term: string;
  definition: string;
  category: string;
  related_terms: string[];
  usage_example?: string | null;
  source_url?: string | null;
}

export interface ExtensionSettings {
  mode: TermPopMode;
  llm: LlmSettings;
}

export interface LlmSettings {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  language: ExplanationLanguage;
  includeUsageExample: boolean;
  maxConcurrency: number;
  temperature: number;
  maxTokens: number;
}

export interface ExplainRequest {
  type: "TERMPOP_EXPLAIN";
  term: string;
  context?: string;
  cacheScope?: string;
  refresh?: boolean;
}

export interface ExplainResponse {
  ok: boolean;
  explanation?: Explanation;
  error?: string;
}

export interface ExplainSelectionRequest {
  type: "TERMPOP_EXPLAIN_SELECTION";
  term: string;
}

export interface ExplainSelectionResponse {
  ok: boolean;
  error?: string;
}

export interface DetectTermsRequest {
  type: "TERMPOP_DETECT_TERMS";
  text: string;
  detectionMode?: "primary" | "llm" | "all";
}

export interface DetectTermsResponse {
  ok: boolean;
  terms?: DetectedTerm[];
  debug?: DetectTermsDebug;
  error?: string;
}

export interface DetectTermsDebug {
  rawCandidateCount?: number;
  matchedCount?: number;
  rejectedCount?: number;
  unmatchedCount?: number;
  chunkCount?: number;
  sampleCandidates?: string[];
  sampleMatchedTerms?: string[];
}

export interface GetCachedTermsRequest {
  type: "TERMPOP_GET_CACHED_TERMS";
}

export interface GetCachedTermsResponse {
  ok: boolean;
  terms?: CachedTermEntry[];
  error?: string;
}

export interface AddCachedTermsRequest {
  type: "TERMPOP_ADD_CACHED_TERMS";
  terms: DetectedTerm[];
}

export interface AddCachedTermsResponse {
  ok: boolean;
  error?: string;
}
