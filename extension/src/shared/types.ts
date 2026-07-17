export type TermType = "Tech" | "Brand" | "Person" | "Place" | "Acronym" | "Custom";
export type DetectionSource = "Rule" | "Dictionary" | "Ner" | "User";
export type TermPopMode = "hover" | "selection" | "hybrid";
export type LlmProvider = "mock" | "openai" | "kimi" | "openai-compatible" | "anthropic";
export type ExplanationLanguage = "auto" | "zh-CN" | "en";
export type CacheScope = "global" | "domain" | "pageFingerprint";

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
  scope: CacheScope;
  domain?: string | null;
  page_fingerprint?: string | null;
  seen_count?: number;
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
  dictionary: TermDictionarySettings;
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
  advancedVisible?: boolean;
  debugLogging?: boolean;
}

export interface TermDictionaryEntry {
  term: string;
  term_type?: TermType;
  confidence?: number;
}

export interface TermDictionarySettings {
  base: TermDictionaryEntry[];
  domain: TermDictionaryEntry[];
  user: TermDictionaryEntry[];
}

export interface ExplainRequest {
  type: "TERMPOP_EXPLAIN";
  term: string;
  context?: string;
  cacheScope?: string;
  url?: string;
  pageFingerprint?: string;
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
  url?: string;
  pageFingerprint?: string;
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
  url?: string;
  pageFingerprint?: string;
}

export interface GetCachedTermsResponse {
  ok: boolean;
  terms?: CachedTermEntry[];
  error?: string;
}

export interface AddCachedTermsRequest {
  type: "TERMPOP_ADD_CACHED_TERMS";
  terms: DetectedTerm[];
  url?: string;
  pageFingerprint?: string;
  scope?: CacheScope;
}

export interface AddCachedTermsResponse {
  ok: boolean;
  error?: string;
}

export interface SiteAccessState {
  url: string;
  originPattern: string;
  supported: boolean;
  enabled: boolean;
  hasPermission: boolean;
}

export interface GetSiteAccessRequest {
  type: "TERMPOP_GET_SITE_ACCESS";
}

export interface GetSiteAccessResponse {
  ok: boolean;
  access?: SiteAccessState;
  error?: string;
}

export interface SetSiteAccessRequest {
  type: "TERMPOP_SET_SITE_ACCESS";
  originPattern: string;
  enabled: boolean;
}

export interface SetSiteAccessResponse {
  ok: boolean;
  access?: SiteAccessState;
  error?: string;
}

export interface InjectActiveTabRequest {
  type: "TERMPOP_INJECT_ACTIVE_TAB";
}

export interface InjectActiveTabResponse {
  ok: boolean;
  injected?: boolean;
  error?: string;
}

export interface DisableSiteRequest {
  type: "TERMPOP_DISABLE_SITE";
}

export interface DisableSiteResponse {
  ok: boolean;
  error?: string;
}

export function normalizeTermType(value: unknown): TermType {
  if (value === "Tech" || value === "Brand" || value === "Person" || value === "Place" || value === "Acronym" || value === "Custom") {
    return value;
  }
  return "Custom";
}
