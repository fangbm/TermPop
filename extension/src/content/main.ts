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
  ExplainSelectionRequest,
  ExplainSelectionResponse,
  Explanation,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  TermLensMode
} from "../shared/types";
import { TermLensOverlayController } from "../shared/overlay";
import { filterAllowedDetectedTerms, findAllowedOccurrences } from "../shared/term-matching";
import styles from "./styles.css?inline";
import overlayStyles from "../shared/overlay.css?inline";

const MAX_HIGHLIGHTS_AUTO = 80;
const MAX_HIGHLIGHTS_HYBRID = 40;
const MAX_HIGHLIGHTS_PER_TERM = 8;
const LLM_DETECTION_CONCURRENCY = 5;
const LLM_DETECTION_NODE_LIMIT = 40;
const HIGHLIGHT_CLASS = "termlens-highlight";
const ROOT_ID = "termlens-overlay-root";
const SETTINGS_KEY = "termlens.settings";
const RESCAN_DELAY_MS = 500;
const HOVER_SHOW_DELAY_MS = 420;

let overlay: TermLensOverlayController | undefined;
let activeMode: TermLensMode = "hover";
let scanTimer: number | undefined;
let cacheFlushTimer: number | undefined;
let selectionAnchor: HTMLElement | undefined;
let mutationObserver: MutationObserver | undefined;
let scanGeneration = 0;
let lastContextMenuPoint: { x: number; y: number; time: number } | undefined;
let globalCachedTerms: CachedTermEntry[] = [];
const pageExplanationCache = new Map<string, Explanation>();
const pendingCachedTerms = new Map<string, DetectedTerm>();
const hoverTimers = new WeakMap<HTMLElement, number>();
const debugOptions = readDebugOptions();

type DetectionModeOverride = "primary" | "llm" | "all";
type TextNodeSpan = {
  node: Text;
  start: number;
  end: number;
};

interface DebugOptions {
  detectionMode?: DetectionModeOverride;
  disableCache: boolean;
}

void boot();

async function boot(): Promise<void> {
  await initWasm({ module_or_path: chrome.runtime.getURL("assets/termlens_core_bg.wasm") });
  injectStyles();
  overlay = new TermLensOverlayController({
    rootId: ROOT_ID,
    anchorSelector: `.${HIGHLIGHT_CLASS}`
  });

  const settings = await getSettings();
  globalCachedTerms = debugOptions.disableCache ? [] : await loadGlobalCachedTerms();
  activeMode = debugOptions.detectionMode ? "hover" : settings.mode;
  console.info("TermLens content boot", {
    mode: activeMode,
    debugOptions,
    url: location.href
  });
  setupSelectionMessageListener();
  setupSelectionPointerTracking();
  setupModeChangeListener();
  if (activeMode === "selection" && !debugOptions.detectionMode) {
    return;
  }

  startAutomaticHighlighting();
}

function injectStyles(): void {
  if (document.getElementById("termlens-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "termlens-styles";
  style.textContent = `${styles}\n${overlayStyles}`;
  document.documentElement.append(style);
}

async function scanAndHighlight(mode: TermLensMode): Promise<void> {
  if (mode === "selection" && !debugOptions.detectionMode) {
    return;
  }

  const currentScanGeneration = ++scanGeneration;
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

  if (debugOptions.detectionMode === "llm") {
    await scanLlmDebugBlocks(limit, termHighlightCounts);
    return;
  }

  for (const node of nodes) {
    if (!isCurrentScan(currentScanGeneration)) {
      return;
    }
    if (highlighted >= limit) {
      break;
    }

    const terms = shouldUseLocalDetection() ? detectTermsLocally(node.data) : [];
    rememberDetectedTerms(terms);
    if (terms.length === 0) {
      if (shouldAskLlmForNode(node)) {
        llmCandidates.push(node);
      }
      continue;
    }

    const allowedTerms = takeAllowedTerms(terms, termHighlightCounts, limit - highlighted);
    if (!isCurrentScan(currentScanGeneration)) {
      return;
    }
    highlighted += highlightTextNode(node, allowedTerms);
  }

  if (highlighted >= limit || llmCandidates.length === 0) {
    return;
  }

  const candidates = llmCandidates.slice(0, LLM_DETECTION_NODE_LIMIT);
  for (let index = 0; index < candidates.length && highlighted < limit; index += LLM_DETECTION_CONCURRENCY) {
    if (!isCurrentScan(currentScanGeneration)) {
      return;
    }
    const chunk = candidates.slice(index, index + LLM_DETECTION_CONCURRENCY);
    const detected = await Promise.all(
      chunk.map(async (node) => ({
        node,
        terms: await detectTerms(node.data)
      }))
    );

    for (const { node, terms } of detected) {
      if (!isCurrentScan(currentScanGeneration)) {
        return;
      }
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

function isCurrentScan(scanId: number): boolean {
  return scanId === scanGeneration && (activeMode !== "selection" || Boolean(debugOptions.detectionMode));
}

async function scanLlmDebugBlocks(limit: number, termHighlightCounts: Map<string, number>): Promise<number> {
  const blocks = getLlmDebugScanBlocks().slice(0, LLM_DETECTION_NODE_LIMIT);
  const batches = collectLlmDebugBlockBatches(blocks);
  let highlighted = 0;

  for (const batch of batches) {
    if (highlighted >= limit) {
      break;
    }

    console.info("TermLens LLM block batch request", {
      textPreview: batch.text.slice(0, 260),
      nodeCount: batch.spans.length
    });
    const terms = await detectTerms(batch.text);
    const allowedTerms = takeAllowedTerms(terms, termHighlightCounts, limit - highlighted);
    highlighted += highlightTextNodeSpans(batch.spans, allowedTerms);
  }

  return highlighted;
}

function collectLlmDebugBlockBatches(blocks: HTMLElement[]): Array<{ text: string; spans: TextNodeSpan[] }> {
  const batches: Array<{ text: string; spans: TextNodeSpan[] }> = [];
  let currentText = "";
  let currentSpans: TextNodeSpan[] = [];
  const maxBatchLength = 3000;

  for (const block of blocks) {
    const blockText = collectTextNodeSpans(block);
    if (blockText.text.trim().length < 12 || blockText.spans.length === 0) {
      continue;
    }

    const separator = currentText ? "\n\n" : "";
    if (currentText && currentText.length + separator.length + blockText.text.length > maxBatchLength) {
      batches.push({ text: currentText, spans: currentSpans });
      currentText = "";
      currentSpans = [];
    }

    const offset = currentText ? currentText.length + 2 : 0;
    if (currentText) {
      currentText += "\n\n";
    }
    currentText += blockText.text;
    currentSpans.push(...blockText.spans.map((span) => ({
      ...span,
      start: offset + span.start,
      end: offset + span.end
    })));
  }

  if (currentText) {
    batches.push({ text: currentText, spans: currentSpans });
  }

  return batches;
}

function getLlmDebugScanBlocks(): HTMLElement[] {
  const scopedBlocks = [...document.querySelectorAll<HTMLElement>("[data-termlens-scan] p, [data-termlens-scan] li")];
  if (scopedBlocks.length > 0) {
    return scopedBlocks.filter(isVisibleElement);
  }

  return [...document.querySelectorAll<HTMLElement>("article p, article li, main p")]
    .filter((element) => !element.closest("[data-termlens-ignore]"))
    .filter(isVisibleElement);
}

function isVisibleElement(element: HTMLElement): boolean {
  if (element.closest("[data-termlens-ignore]")) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function collectTextNodeSpans(root: HTMLElement): { text: string; spans: TextNodeSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim() || !isHighlightableTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let text = "";
  const spans: TextNodeSpan[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const start = text.length;
    text += node.data;
    spans.push({
      node,
      start,
      end: text.length
    });
  }

  return { text, spans };
}

function highlightTextNodeSpans(spans: TextNodeSpan[], terms: DetectedTerm[]): number {
  let count = 0;
  for (const span of spans) {
    if (!span.node.parentNode || !isHighlightableTextNode(span.node)) {
      continue;
    }

    const nodeTerms = terms
      .filter((term) => term.start >= span.start && term.end <= span.end)
      .map((term) => ({
        ...term,
        start: term.start - span.start,
        end: term.end - span.start
      }));
    count += highlightTextNode(span.node, nodeTerms);
  }

  return count;
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

function setupModeChangeListener(): void {
  if (debugOptions.detectionMode) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTINGS_KEY]) {
      return;
    }
    void getSettings().then((settings) => {
      applyModeChange(settings.mode);
    });
  });
}

function applyModeChange(nextMode: TermLensMode): void {
  if (activeMode === nextMode) {
    return;
  }

  activeMode = nextMode;
  console.info("TermLens mode changed", { mode: activeMode });
  if (activeMode === "selection") {
    stopAutomaticHighlighting();
    removeAllHighlights();
    overlay?.hide();
    return;
  }

  removeAllHighlights();
  startAutomaticHighlighting();
}

function startAutomaticHighlighting(): void {
  observeDynamicContent();
  void scanAndHighlight(activeMode);
}

function stopAutomaticHighlighting(): void {
  scanGeneration += 1;
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
    scanTimer = undefined;
  }
  mutationObserver?.disconnect();
  mutationObserver = undefined;
}

function removeAllHighlights(): void {
  scanGeneration += 1;
  const highlights = Array.from(document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`));
  for (const highlight of highlights) {
    const parent = highlight.parentNode;
    if (!parent) {
      continue;
    }
    parent.replaceChild(document.createTextNode(highlight.textContent ?? ""), highlight);
    parent.normalize();
  }
}

function observeDynamicContent(): void {
  if (mutationObserver) {
    return;
  }

  mutationObserver = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target instanceof Element && mutation.target.closest(`#${ROOT_ID}, .${HIGHLIGHT_CLASS}`))) {
      return;
    }

    scheduleScan();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function scheduleScan(): void {
  if (activeMode === "selection" && !debugOptions.detectionMode) {
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

function setupSelectionMessageListener(): void {
  chrome.runtime.onMessage.addListener((message: ExplainSelectionRequest, _sender, sendResponse) => {
    if (message.type !== "TERMLENS_EXPLAIN_SELECTION") {
      return false;
    }

    void explainSelectedText(message.term)
      .then(() => sendResponse({ ok: true } satisfies ExplainSelectionResponse))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason } satisfies ExplainSelectionResponse);
      });
    return true;
  });
}

function setupSelectionPointerTracking(): void {
  document.addEventListener(
    "contextmenu",
    (event) => {
      lastContextMenuPoint = {
        x: event.clientX,
        y: event.clientY,
        time: Date.now()
      };
    },
    true
  );
}

async function explainSelectedText(rawTerm: string): Promise<void> {
  const termText = normalizeSelectedTerm(rawTerm);
  if (!termText) {
    return;
  }

  const anchor = ensureSelectionAnchor();
  anchorFromSelection(anchor, lastContextMenuPoint);
  const term: DetectedTerm = {
    term: termText,
    start: 0,
    end: termText.length,
    term_type: "Custom",
    confidence: 1,
    source: "User"
  };

  await showExplanation(anchor, term, selectionContext(termText), { refresh: false, pin: true });
}

function normalizeSelectedTerm(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function ensureSelectionAnchor(): HTMLElement {
  if (selectionAnchor?.isConnected) {
    return selectionAnchor;
  }

  selectionAnchor = document.createElement("span");
  selectionAnchor.id = "termlens-selection-anchor";
  selectionAnchor.style.position = "fixed";
  selectionAnchor.style.width = "1px";
  selectionAnchor.style.height = "1px";
  selectionAnchor.style.pointerEvents = "none";
  selectionAnchor.style.opacity = "0";
  selectionAnchor.style.zIndex = "-1";
  document.documentElement.append(selectionAnchor);
  return selectionAnchor;
}

function anchorFromSelection(anchor: HTMLElement, fallbackPoint?: { x: number; y: number; time: number }): void {
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  const rect = firstUsableRect(range?.getClientRects()) ?? range?.getBoundingClientRect();

  if (rect && rect.width > 0 && rect.height > 0) {
    anchor.style.left = `${rect.left}px`;
    anchor.style.top = `${rect.top}px`;
    anchor.style.width = `${Math.max(1, rect.width)}px`;
    anchor.style.height = `${Math.max(1, rect.height)}px`;
    return;
  }

  if (fallbackPoint && Date.now() - fallbackPoint.time < 8000) {
    anchor.style.left = `${clampViewportX(fallbackPoint.x)}px`;
    anchor.style.top = `${clampViewportY(fallbackPoint.y)}px`;
    anchor.style.width = "1px";
    anchor.style.height = "1px";
    return;
  }

  anchor.style.left = `${Math.max(0, window.innerWidth / 2 - 1)}px`;
  anchor.style.top = `${Math.max(0, window.innerHeight / 2 - 1)}px`;
  anchor.style.width = "1px";
  anchor.style.height = "1px";
}

function clampViewportX(value: number): number {
  return Math.min(Math.max(0, value), Math.max(0, window.innerWidth - 1));
}

function clampViewportY(value: number): number {
  return Math.min(Math.max(0, value), Math.max(0, window.innerHeight - 1));
}

function firstUsableRect(rects: DOMRectList | undefined): DOMRect | undefined {
  if (!rects) {
    return undefined;
  }
  for (const rect of Array.from(rects)) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }
  return undefined;
}

function selectionContext(term: string): string {
  const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
  const index = bodyText.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) {
    return term;
  }
  const start = Math.max(0, index - 500);
  const end = Math.min(bodyText.length, index + term.length + 500);
  return bodyText.slice(start, end);
}

async function detectTerms(text: string): Promise<DetectedTerm[]> {
  try {
    console.info("TermLens detect terms request", {
      detectionMode: debugOptions.detectionMode,
      disableCache: debugOptions.disableCache,
      textPreview: text.slice(0, 180)
    });
    const response = await chrome.runtime.sendMessage({
      type: "TERMLENS_DETECT_TERMS",
      text,
      detectionMode: debugOptions.detectionMode
    } satisfies DetectTermsRequest) as DetectTermsResponse;

    if (response.ok && response.terms) {
      console.info("TermLens detect terms response", {
        count: response.terms.length,
        debug: response.debug,
        terms: response.terms.map((term) => term.term).slice(0, 20)
      });
      if (!debugOptions.disableCache) {
        mergeGlobalCachedTerms(response.terms);
      }
      return response.terms;
    }
    console.warn("TermLens detect terms failed response", response);
  } catch (error) {
    console.warn("TermLens detect terms request failed", error);
    // Local WASM fallback below keeps highlighting usable if the service worker is unavailable.
  }

  if (debugOptions.detectionMode === "llm") {
    return [];
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
  const cachedTerms = debugOptions.disableCache ? [] : detectCachedTermsLocally(text);
  return dedupeDetectedTerms(filterAllowedDetectedTerms(text, [...rustTerms, ...cachedTerms]));
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
    for (const [start, end] of findAllowedOccurrences(text, entry.term)) {
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
  if (debugOptions.disableCache) {
    return;
  }

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
  if (debugOptions.disableCache) {
    return;
  }

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

function readDebugOptions(): DebugOptions {
  const params = new URLSearchParams(window.location.search);
  const detectionMode = params.get("termlensDetection");
  return {
    detectionMode: detectionMode === "primary" || detectionMode === "llm" || detectionMode === "all"
      ? detectionMode
      : undefined,
    disableCache: params.get("termlensCache") === "0" || params.get("termlensNoCache") === "1"
  };
}

function shouldUseLocalDetection(): boolean {
  return debugOptions.detectionMode !== "llm";
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

  const blocked = parent.closest("script, style, noscript, input, textarea, select, option, [contenteditable='true'], [data-termlens-ignore]");
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
    wrapper.addEventListener("mouseenter", (event) => {
      scheduleHoverExplanation(wrapper, term, text, event);
    });
    wrapper.addEventListener("mouseleave", () => {
      cancelHoverExplanation(wrapper);
      overlay?.scheduleHide();
    });
    wrapper.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelHoverExplanation(wrapper);
      void showExplanation(wrapper, term, text, { refresh: false, pin: true, pointer: event });
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

interface ShowExplanationOptions {
  refresh: boolean;
  pin: boolean;
  pointer?: MouseEvent | PointerEvent;
}
function scheduleHoverExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, pointer: MouseEvent): void {
  cancelHoverExplanation(anchor);
  const timer = window.setTimeout(() => {
    hoverTimers.delete(anchor);
    if (!anchor.matches(":hover")) {
      return;
    }
    void showExplanation(anchor, term, context, { refresh: false, pin: false, pointer });
  }, HOVER_SHOW_DELAY_MS);
  hoverTimers.set(anchor, timer);
}

function cancelHoverExplanation(anchor: HTMLElement): void {
  const timer = hoverTimers.get(anchor);
  if (timer === undefined) {
    return;
  }
  window.clearTimeout(timer);
  hoverTimers.delete(anchor);
}

async function showExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, options: ShowExplanationOptions): Promise<void> {
  const cacheKey = explanationResultCacheKey(term.term, context);
  const cached = pageExplanationCache.get(cacheKey);
  if (cached && !options.refresh) {
    overlay?.showExplanation(anchor, cached, () => {
      void showExplanation(anchor, term, context, { refresh: true, pin: true });
    }, options.pin, true, options.pointer);
    return;
  }

  overlay?.showLoading(anchor, term.term, options.pin, !options.refresh, options.pointer);

  const response = await chrome.runtime.sendMessage({
    type: "TERMLENS_EXPLAIN",
    term: term.term,
    context,
    cacheScope: cacheKey,
    refresh: options.refresh
  } satisfies ExplainRequest) as ExplainResponse;

  if (!response.ok || !response.explanation) {
    overlay?.showError(anchor, term.term, response.error ?? "暂时无法解释这个词。", options.pin, !options.refresh, options.pointer);
    return;
  }

  pageExplanationCache.set(cacheKey, response.explanation);
  if (!options.pin && !anchor.matches(":hover") && !overlay?.isPointerOverCard()) {
    return;
  }

  overlay?.showExplanation(anchor, response.explanation, () => {
    void showExplanation(anchor, term, context, { refresh: true, pin: true });
  }, options.pin, !options.refresh, options.pointer);
}

function explanationCacheKey(term: string): string {
  return term.trim().toLocaleLowerCase();
}

function explanationResultCacheKey(term: string, context: string): string {
  return `${explanationCacheKey(term)}\n${hashString(context.replace(/\s+/g, " ").trim().slice(0, 1200))}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
