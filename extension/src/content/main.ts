import initWasm, { detect_terms_json } from "../wasm/termlens_core.js";
import { getSettings } from "../shared/settings";
import type {
  AddCachedTermsRequest,
  CachedTermEntry,
  DetectTermsRequest,
  DetectTermsResponse,
  DetectedTerm,
  ExplainRequest,
  ExplainResponse,
  Explanation,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  TermLensMode
} from "../shared/types";
import styles from "./styles.css?inline";

const MAX_HIGHLIGHTS_AUTO = 80;
const MAX_HIGHLIGHTS_HYBRID = 40;
const MAX_HIGHLIGHTS_PER_TERM = 8;
const LLM_DETECTION_CONCURRENCY = 5;
const LLM_DETECTION_NODE_LIMIT = 40;
const HIGHLIGHT_CLASS = "termlens-highlight";
const ROOT_ID = "termlens-overlay-root";
const RESCAN_DELAY_MS = 500;

let overlay: OverlayController | undefined;
let activeMode: TermLensMode = "auto";
let scanTimer: number | undefined;
let cacheFlushTimer: number | undefined;
let globalCachedTerms: CachedTermEntry[] = [];
const pageExplanationCache = new Map<string, Explanation>();
const pendingCachedTerms = new Map<string, DetectedTerm>();

void boot();

async function boot(): Promise<void> {
  await initWasm({ module_or_path: chrome.runtime.getURL("assets/termlens_core_bg.wasm") });
  injectStyles();
  overlay = new OverlayController();

  const settings = await getSettings();
  globalCachedTerms = await loadGlobalCachedTerms();
  activeMode = settings.mode;
  if (settings.mode === "hover") {
    return;
  }

  void scanAndHighlight(settings.mode);
  observeDynamicContent();
}

function injectStyles(): void {
  if (document.getElementById("termlens-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "termlens-styles";
  style.textContent = styles;
  document.documentElement.append(style);
}

async function scanAndHighlight(mode: TermLensMode): Promise<void> {
  const limit = mode === "hybrid" ? MAX_HIGHLIGHTS_HYBRID : MAX_HIGHLIGHTS_AUTO;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!isHighlightableTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }

  let highlighted = 0;
  const termHighlightCounts = new Map<string, number>();
  const llmCandidates: Text[] = [];

  for (const node of nodes) {
    if (highlighted >= limit) {
      break;
    }

    const terms = detectTermsLocally(node.data);
    rememberDetectedTerms(terms);
    if (terms.length === 0) {
      if (shouldAskLlmForNode(node)) {
        llmCandidates.push(node);
      }
      continue;
    }

    const allowedTerms = takeAllowedTerms(terms, termHighlightCounts, limit - highlighted);
    highlighted += highlightTextNode(node, allowedTerms);
  }

  if (highlighted >= limit || llmCandidates.length === 0) {
    return;
  }

  const candidates = llmCandidates.slice(0, LLM_DETECTION_NODE_LIMIT);
  for (let index = 0; index < candidates.length && highlighted < limit; index += LLM_DETECTION_CONCURRENCY) {
    const chunk = candidates.slice(index, index + LLM_DETECTION_CONCURRENCY);
    const detected = await Promise.all(
      chunk.map(async (node) => ({
        node,
        terms: await detectTerms(node.data)
      }))
    );

    for (const { node, terms } of detected) {
      if (highlighted >= limit) {
        break;
      }
      if (!node.parentNode || !isHighlightableTextNode(node)) {
        continue;
      }
      if (terms.length === 0) {
        continue;
      }

      rememberDetectedTerms(terms);
      const allowedTerms = takeAllowedTerms(terms, termHighlightCounts, limit - highlighted);
      highlighted += highlightTextNode(node, allowedTerms);
    }
  }
}

function takeAllowedTerms(terms: DetectedTerm[], counts: Map<string, number>, remaining: number): DetectedTerm[] {
  const allowed: DetectedTerm[] = [];
  for (const term of terms) {
    if (allowed.length >= remaining) {
      break;
    }

    const key = explanationCacheKey(term.term);
    const count = counts.get(key) ?? 0;
    if (count >= MAX_HIGHLIGHTS_PER_TERM) {
      continue;
    }

    counts.set(key, count + 1);
    allowed.push(term);
  }
  return allowed;
}

function shouldAskLlmForNode(node: Text): boolean {
  const text = node.data.trim();
  return text.length >= 12 && text.length <= 1200;
}

function observeDynamicContent(): void {
  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target instanceof Element && mutation.target.closest(`#${ROOT_ID}, .${HIGHLIGHT_CLASS}`))) {
      return;
    }

    scheduleScan();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function scheduleScan(): void {
  if (activeMode === "hover") {
    return;
  }

  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    void scanAndHighlight(activeMode);
  }, RESCAN_DELAY_MS);
}

async function detectTerms(text: string): Promise<DetectedTerm[]> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TERMLENS_DETECT_TERMS",
      text
    } satisfies DetectTermsRequest) as DetectTermsResponse;

    if (response.ok && response.terms) {
      mergeGlobalCachedTerms(response.terms);
      return response.terms;
    }
  } catch {
    // Local WASM fallback below keeps highlighting usable if the service worker is unavailable.
  }

  return detectTermsLocally(text);
}

function detectTermsLocally(text: string): DetectedTerm[] {
  const raw = detect_terms_json(text);
  const rustTerms = (JSON.parse(raw) as DetectedTerm[]).map((term) => ({
    ...term,
    start: byteOffsetToJsIndex(text, term.start),
    end: byteOffsetToJsIndex(text, term.end)
  }));
  return dedupeDetectedTerms([...rustTerms, ...detectCachedTermsLocally(text)]);
}

async function loadGlobalCachedTerms(): Promise<CachedTermEntry[]> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TERMLENS_GET_CACHED_TERMS"
    } satisfies GetCachedTermsRequest) as GetCachedTermsResponse;

    if (response.ok && response.terms) {
      return response.terms;
    }
  } catch {
    // The extension still works with Rust-only local detection if the service worker is unavailable.
  }

  return [];
}

function detectCachedTermsLocally(text: string): DetectedTerm[] {
  const terms: DetectedTerm[] = [];
  for (const entry of globalCachedTerms) {
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
  return terms;
}

function rememberDetectedTerms(terms: DetectedTerm[]): void {
  let changed = false;
  for (const term of terms) {
    const key = explanationCacheKey(term.term);
    if (key.length < 2 || term.term.trim().length > 80) {
      continue;
    }

    const existing = pendingCachedTerms.get(key);
    if (!existing || term.confidence >= existing.confidence) {
      pendingCachedTerms.set(key, term);
      changed = true;
    }
  }

  if (!changed || cacheFlushTimer !== undefined) {
    return;
  }

  cacheFlushTimer = window.setTimeout(() => {
    cacheFlushTimer = undefined;
    const termsToFlush = [...pendingCachedTerms.values()];
    pendingCachedTerms.clear();
    mergeGlobalCachedTerms(termsToFlush);
    void chrome.runtime.sendMessage({
      type: "TERMLENS_ADD_CACHED_TERMS",
      terms: termsToFlush
    } satisfies AddCachedTermsRequest);
  }, 500);
}

function mergeGlobalCachedTerms(terms: DetectedTerm[]): void {
  if (terms.length === 0) {
    return;
  }

  const byKey = new Map(globalCachedTerms.map((term) => [explanationCacheKey(term.term), term]));
  for (const term of terms) {
    const key = explanationCacheKey(term.term);
    if (key.length < 2 || term.term.trim().length > 80) {
      continue;
    }

    const existing = byKey.get(key);
    if (!existing || term.confidence >= existing.confidence) {
      byKey.set(key, {
        term: term.term.trim(),
        term_type: term.term_type,
        confidence: term.confidence,
        source: term.source,
        last_seen_at: Date.now()
      });
    }
  }

  globalCachedTerms = [...byKey.values()];
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

function isHighlightableTextNode(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }

  if (parent.closest(`.${HIGHLIGHT_CLASS}, #${ROOT_ID}`)) {
    return false;
  }

  const blocked = parent.closest("script, style, noscript, input, textarea, select, option, [contenteditable='true']");
  if (blocked) {
    return false;
  }

  const style = window.getComputedStyle(parent);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function highlightTextNode(node: Text, terms: DetectedTerm[]): number {
  const text = node.data;
  const validTerms = terms
    .filter((term) => term.start >= 0 && term.end <= text.length && term.start < term.end)
    .sort((left, right) => left.start - right.start);

  if (validTerms.length === 0 || !node.parentNode) {
    return 0;
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let count = 0;

  for (const term of validTerms) {
    if (term.start < cursor) {
      continue;
    }

    if (term.start > cursor) {
      fragment.append(document.createTextNode(text.slice(cursor, term.start)));
    }

    const wrapper = document.createElement("span");
    wrapper.className = HIGHLIGHT_CLASS;
    wrapper.dataset.term = term.term;
    wrapper.dataset.termType = term.term_type;
    wrapper.textContent = text.slice(term.start, term.end);
    wrapper.addEventListener("mouseenter", () => {
      void showExplanation(wrapper, term, text, false);
    });
    wrapper.addEventListener("mouseleave", () => {
      overlay?.scheduleHide();
    });
    fragment.append(wrapper);

    cursor = term.end;
    count += 1;
  }

  if (cursor < text.length) {
    fragment.append(document.createTextNode(text.slice(cursor)));
  }

  node.parentNode.replaceChild(fragment, node);
  return count;
}

async function showExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, refresh: boolean): Promise<void> {
  const cacheKey = explanationCacheKey(term.term);
  const cached = pageExplanationCache.get(cacheKey);
  if (cached && !refresh) {
    overlay?.showExplanation(anchor, cached, () => {
      void showExplanation(anchor, term, context, true);
    });
    return;
  }

  overlay?.showLoading(anchor, term.term);

  const response = await chrome.runtime.sendMessage({
    type: "TERMLENS_EXPLAIN",
    term: term.term,
    context,
    cacheScope: cacheKey,
    refresh
  } satisfies ExplainRequest) as ExplainResponse;

  if (!response.ok || !response.explanation) {
    overlay?.showError(anchor, term.term, response.error ?? "暂时无法解释这个词。");
    return;
  }

  pageExplanationCache.set(cacheKey, response.explanation);
  overlay?.showExplanation(anchor, response.explanation, () => {
    void showExplanation(anchor, term, context, true);
  });
}

function explanationCacheKey(term: string): string {
  return term.trim().toLocaleLowerCase();
}

class OverlayController {
  private readonly root: HTMLDivElement;
  private hideTimer: number | undefined;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = ROOT_ID;
    this.root.addEventListener("mouseenter", () => this.cancelHide());
    this.root.addEventListener("mouseleave", () => this.scheduleHide());
    document.documentElement.append(this.root);
  }

  showLoading(anchor: HTMLElement, term: string): void {
    this.render(anchor, `<div class="termlens-card-title">${escapeHtml(term)}</div><div class="termlens-muted">正在生成解释...</div>`);
  }

  showError(anchor: HTMLElement, term: string, message: string): void {
    this.render(
      anchor,
      `<div class="termlens-card-title">${escapeHtml(term)}</div><div class="termlens-error">${escapeHtml(message)}</div>`
    );
  }

  showExplanation(anchor: HTMLElement, explanation: Explanation, onRefresh: () => void): void {
    const related = explanation.related_terms.map((term) => `<span>${escapeHtml(term)}</span>`).join("");
    this.render(
      anchor,
      `<div class="termlens-card-header">
         <div class="termlens-card-title">${escapeHtml(explanation.term)}</div>
         <button class="termlens-refresh-button" type="button" title="重新生成解释" aria-label="重新生成解释">↻</button>
       </div>
       <div class="termlens-category">${escapeHtml(explanation.category)}</div>
       <div class="termlens-definition">${escapeHtml(explanation.definition)}</div>
       ${explanation.usage_example ? `<div class="termlens-example">${escapeHtml(explanation.usage_example)}</div>` : ""}
       <div class="termlens-related">${related}</div>`
    );
    this.root.querySelector<HTMLButtonElement>(".termlens-refresh-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRefresh();
    });
  }

  scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => {
      this.root.classList.remove("is-visible");
    }, 160);
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  private render(anchor: HTMLElement, html: string): void {
    this.cancelHide();
    this.root.innerHTML = `<div class="termlens-card">${html}</div>`;
    this.root.classList.add("is-visible");

    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = this.root.getBoundingClientRect();
    const left = clamp(anchorRect.left + anchorRect.width / 2 - cardRect.width / 2, 12, window.innerWidth - cardRect.width - 12);
    const topCandidate = anchorRect.top - cardRect.height - 10;
    const top = topCandidate > 12 ? topCandidate : anchorRect.bottom + 10;

    this.root.style.left = `${left + window.scrollX}px`;
    this.root.style.top = `${top + window.scrollY}px`;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
