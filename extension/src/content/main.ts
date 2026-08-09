import initWasm, { detect_terms_json } from "../wasm/termpop_core.js";
import { getContentSettings } from "../shared/settings";
import type {
  AddCachedTermsRequest,
  BeginScreenshotSelectionRequest,
  BeginScreenshotSelectionResponse,
  CachedTermEntry,
  DetectTermsRequest,
  DetectTermsResponse,
  DetectedTerm,
  DisableSiteRequest,
  DisableSiteResponse,
  ExplainRequest,
  ExplainResponse,
  ExplainSelectionRequest,
  ExplainSelectionResponse,
  Explanation,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  GetSiteAccessResponse,
  RecognizeScreenshotRequest,
  RecognizeScreenshotResponse,
  TermPopMode
} from "../shared/types";
import { TermPopOverlayController } from "../shared/overlay";
import { byteOffsetToJsIndex } from "../shared/byte-offset";
import { normalizeTermType } from "../shared/types";
import { filterAllowedDetectedTerms, findAllowedOccurrences } from "../shared/term-matching";
import { BLOCKED_SITES_STORAGE_KEY, explanationResultCacheScope, pageFingerprintFromUrlAndText, sanitizeForLog } from "../shared/browser-utils";
import styles from "./styles.css?inline";
import overlayStyles from "../shared/overlay.css?inline";
import screenshotSelectionStyles from "./screenshot-selection.css?inline";
import { isCachedTermAvailable, mergeCachedTermView } from "./cache-view";
import { ScreenshotSelectionController, type ScreenshotSelectionResult } from "./screenshot-selection";

const MAX_HIGHLIGHTS_AUTO = 80;
const MAX_HIGHLIGHTS_HYBRID = 40;
const MAX_HIGHLIGHTS_PER_TERM = 8;
const LLM_DETECTION_CONCURRENCY = 5;
const LLM_DETECTION_NODE_LIMIT = 40;
const HIGHLIGHT_CLASS = "termpop-highlight";
const ROOT_ID = "termpop-overlay-root";
const SETTINGS_KEY = "termpop.settings";
const RESCAN_DELAY_MS = 500;
const HOVER_SHOW_DELAY_MS = 420;

let overlay: TermPopOverlayController | undefined;
let activeMode: TermPopMode = "hover";
let scanTimer: number | undefined;
let pendingScanRoots: Node[] = [];
let cacheFlushTimer: number | undefined;
let selectionAnchor: HTMLElement | undefined;
let screenshotAnchor: HTMLElement | undefined;
let screenshotSelection: ScreenshotSelectionController | undefined;
let screenshotRequestSeq = 0;
let mutationObserver: MutationObserver | undefined;
let scanGeneration = 0;
let lastContextMenuPoint: { x: number; y: number; time: number } | undefined;
let globalCachedTerms: CachedTermEntry[] = [];
let highlightEventsBound = false;
let siteDisabled = false;
const pageExplanationCache = new Map<string, Explanation>();
const pendingExplanationRequests = new Map<string, Promise<ExplainResponse>>();
const pendingCachedTerms = new Map<string, DetectedTerm>();
const hoverTimers = new WeakMap<HTMLElement, number>();
const hoverTimerIds = new Set<number>();
const explanationRequestIds = new WeakMap<HTMLElement, number>();
let explanationRequestSeq = 0;
const debugOptions = readDebugOptions();
const runtimeState = globalThis as typeof globalThis & { __termpopBooted?: boolean };
let cachedPageFingerprint: { value: string; at: number; url: string } | undefined;

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

if (!runtimeState.__termpopBooted) {
  runtimeState.__termpopBooted = true;
  void boot();
}

async function boot(): Promise<void> {
  await initWasm({ module_or_path: chrome.runtime.getURL("assets/termpop_core_bg.wasm") });
  injectStyles();
  overlay = new TermPopOverlayController({
    rootId: ROOT_ID,
    anchorSelector: `.${HIGHLIGHT_CLASS}, [data-termpop-virtual-anchor]`,
    locale: uiLocale()
  });
  screenshotSelection = new ScreenshotSelectionController(uiLocale());

  const { mode } = await getContentSettings();
  globalCachedTerms = debugOptions.disableCache ? [] : await loadGlobalCachedTerms();
  activeMode = debugOptions.detectionMode ? "hover" : mode;
  debugLog("TermPop content boot", {
    mode: activeMode,
    debugOptions,
    url: location.href
  });
  setupSiteAccessChangeListener();
  setupSelectionMessageListener();
  setupSelectionPointerTracking();
  setupHighlightEventDelegation();
  setupModeChangeListener();
  if (activeMode === "selection" && !debugOptions.detectionMode) {
    return;
  }

  startAutomaticHighlighting();
}

function injectStyles(): void {
  if (document.getElementById("termpop-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "termpop-styles";
  style.textContent = `${styles}\n${overlayStyles}\n${screenshotSelectionStyles}`;
  document.documentElement.append(style);
}

async function scanAndHighlight(mode: TermPopMode, dirtyRoots?: Node[]): Promise<void> {
  if (siteDisabled) {
    return;
  }
  if (mode === "selection" && !debugOptions.detectionMode) {
    return;
  }

  const currentScanGeneration = ++scanGeneration;
  const limit = mode === "hybrid" ? MAX_HIGHLIGHTS_HYBRID : MAX_HIGHLIGHTS_AUTO;
  const termHighlightCounts = collectExistingHighlightCounts();
  let highlighted = countExistingHighlights(termHighlightCounts);
  if (highlighted >= limit) {
    return;
  }

  const nodes = collectScanTextNodes(dirtyRoots?.length ? dirtyRoots : [document.body]);
  nodes.sort((left, right) => Number(!isTextNodeNearViewport(left)) - Number(!isTextNodeNearViewport(right)));

  const llmCandidates: Text[] = [];

  if (debugOptions.detectionMode === "llm") {
    await scanLlmDebugBlocks(limit, termHighlightCounts, dirtyRoots);
    return;
  }

  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isCurrentScan(currentScanGeneration)) {
      return;
    }
    if (nodeIndex > 0 && nodeIndex % 20 === 0) {
      await yieldToMainThread();
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
  return !siteDisabled && scanId === scanGeneration && (activeMode !== "selection" || Boolean(debugOptions.detectionMode));
}

async function scanLlmDebugBlocks(limit: number, termHighlightCounts: Map<string, number>, dirtyRoots?: Node[]): Promise<number> {
  const blocks = getLlmDebugScanBlocks(dirtyRoots).slice(0, LLM_DETECTION_NODE_LIMIT);
  const batches = collectLlmDebugBlockBatches(blocks);
  let highlighted = 0;

  for (const batch of batches) {
    if (highlighted >= limit) {
      break;
    }

    debugLog("TermPop LLM block batch request", {
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

function getLlmDebugScanBlocks(dirtyRoots?: Node[]): HTMLElement[] {
  if (dirtyRoots?.length) {
    return dirtyRoots
      .flatMap((root) => {
        const element = root instanceof HTMLElement ? root : root.parentElement;
        if (!element) {
          return [];
        }
        const block = element.closest("p, li") as HTMLElement | null;
        const scanRoot = block ?? element;
        return [scanRoot, ...scanRoot.querySelectorAll<HTMLElement>("p, li")];
      })
      .filter((element, index, elements) => elements.indexOf(element) === index)
      .filter(isVisibleElement);
  }

  const scopedBlocks = [...document.querySelectorAll<HTMLElement>("[data-termpop-scan] p, [data-termpop-scan] li")];
  if (scopedBlocks.length > 0) {
    return scopedBlocks.filter(isVisibleElement);
  }

  return [...document.querySelectorAll<HTMLElement>("article p, article li, main p")]
    .filter((element) => !element.closest("[data-termpop-ignore]"))
    .filter(isVisibleElement);
}

function isVisibleElement(element: HTMLElement): boolean {
  if (element.closest("[data-termpop-ignore]")) {
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

function collectExistingHighlightCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const highlight of document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)) {
    const key = explanationCacheKey(highlight.dataset.term || highlight.textContent || "");
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countExistingHighlights(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
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
    const previousDictionary = changes[SETTINGS_KEY].oldValue?.dictionary;
    const nextDictionary = changes[SETTINGS_KEY].newValue?.dictionary;
    const dictionaryChanged = JSON.stringify(previousDictionary ?? {}) !== JSON.stringify(nextDictionary ?? {});
    void getContentSettings().then(({ mode }) => {
      pageExplanationCache.clear();
      const previousMode = activeMode;
      if (dictionaryChanged) {
        overlay?.hide();
        removeAllHighlights();
      }
      applyModeChange(mode);
      if (dictionaryChanged && previousMode === mode && mode !== "selection" && !siteDisabled) {
        startAutomaticHighlighting();
      }
    });
  });
}

function setupSiteAccessChangeListener(): void {
  if (debugOptions.detectionMode) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[BLOCKED_SITES_STORAGE_KEY]) {
      return;
    }
    void chrome.runtime.sendMessage({ type: "TERMPOP_GET_SITE_ACCESS" })
      .then((response: GetSiteAccessResponse) => {
        if (response.ok && response.access?.enabled) {
          void enableSite();
        } else {
          disableSite();
        }
      })
      .catch(() => disableSite());
  });
}

async function enableSite(): Promise<void> {
  if (!siteDisabled) {
    return;
  }
  siteDisabled = false;
  const { mode } = await getContentSettings();
  activeMode = mode;
  if (activeMode !== "selection") {
    startAutomaticHighlighting();
  }
}

function disableSite(): void {
  siteDisabled = true;
  screenshotRequestSeq += 1;
  screenshotSelection?.cancel();
  screenshotAnchor?.remove();
  screenshotAnchor = undefined;
  stopAutomaticHighlighting();
  if (cacheFlushTimer !== undefined) {
    window.clearTimeout(cacheFlushTimer);
    cacheFlushTimer = undefined;
  }
  pendingCachedTerms.clear();
  for (const timer of hoverTimerIds) {
    window.clearTimeout(timer);
  }
  hoverTimerIds.clear();
  overlay?.hide();
  removeAllHighlights();
}

function applyModeChange(nextMode: TermPopMode): void {
  if (siteDisabled) {
    activeMode = nextMode;
    return;
  }
  if (activeMode === nextMode) {
    return;
  }

  const previousMode = activeMode;
  activeMode = nextMode;
  debugLog("TermPop mode changed", { previousMode, mode: activeMode });
  if (activeMode === "selection") {
    stopAutomaticHighlighting();
    removeAllHighlights();
    overlay?.hide();
    return;
  }

  if (previousMode === "selection") {
    removeAllHighlights();
  }
  startAutomaticHighlighting();
}

function startAutomaticHighlighting(): void {
  if (siteDisabled) {
    return;
  }
  observeDynamicContent();
  void scanAndHighlight(activeMode);
}

function stopAutomaticHighlighting(): void {
  scanGeneration += 1;
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
    scanTimer = undefined;
  }
  pendingScanRoots = [];
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
    const dirtyRoots: Node[] = [];
    for (const mutation of mutations) {
      if (isIgnoredMutationNode(mutation.target)) {
        continue;
      }
      if (mutation.type === "characterData") {
        dirtyRoots.push(mutation.target);
      } else {
        for (const addedNode of mutation.addedNodes) {
          if (!isIgnoredMutationNode(addedNode)) {
            dirtyRoots.push(addedNode);
          }
        }
      }
    }
    if (dirtyRoots.length > 0) {
      scheduleScan(dirtyRoots);
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function scheduleScan(dirtyRoots: Node[] = []): void {
  if (siteDisabled) {
    return;
  }
  if (activeMode === "selection" && !debugOptions.detectionMode) {
    return;
  }

  pendingScanRoots.push(...dirtyRoots.filter((root) => root.isConnected));

  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    const roots = pendingScanRoots;
    pendingScanRoots = [];
    void scanAndHighlight(activeMode, roots.length > 0 ? roots : undefined);
  }, RESCAN_DELAY_MS);
}

function isIgnoredMutationNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(`#${ROOT_ID}, .${HIGHLIGHT_CLASS}, [data-termpop-ignore]`));
}

function collectScanTextNodes(roots: Node[]): Text[] {
  const nodes = new Set<Text>();
  for (const root of roots) {
    if (!root.isConnected || isIgnoredMutationNode(root)) {
      continue;
    }
    if (root.nodeType === Node.TEXT_NODE) {
      const textNode = root as Text;
      if (textNode.textContent?.trim() && isHighlightableTextNode(textNode)) {
        nodes.add(textNode);
      }
      continue;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent?.trim() || !isHighlightableTextNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      nodes.add(walker.currentNode as Text);
    }
  }
  return [...nodes];
}

function setupSelectionMessageListener(): void {
  chrome.runtime.onMessage.addListener((
    message: ExplainSelectionRequest | DisableSiteRequest | BeginScreenshotSelectionRequest,
    _sender,
    sendResponse
  ) => {
    if (message.type === "TERMPOP_DISABLE_SITE") {
      disableSite();
      sendResponse({ ok: true } satisfies DisableSiteResponse);
      return false;
    }

    if (message.type === "TERMPOP_BEGIN_SCREENSHOT_SELECTION") {
      if (siteDisabled) {
        sendResponse({ ok: false, error: "TermPop is disabled on this site." } satisfies BeginScreenshotSelectionResponse);
        return false;
      }
      sendResponse({ ok: true } satisfies BeginScreenshotSelectionResponse);
      void beginScreenshotExplanation();
      return false;
    }

    if (message.type !== "TERMPOP_EXPLAIN_SELECTION") {
      return false;
    }

    if (siteDisabled) {
      sendResponse({ ok: false, error: "TermPop is disabled on this site." } satisfies ExplainSelectionResponse);
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

async function beginScreenshotExplanation(): Promise<void> {
  const requestId = ++screenshotRequestSeq;
  try {
    const selection = await screenshotSelection?.begin();
    if (!selection || siteDisabled || requestId !== screenshotRequestSeq) {
      return;
    }
    const anchor = ensureScreenshotAnchor(selection.rect);
    await requestScreenshotExplanation(selection, anchor, requestId, false);
  } catch (error) {
    if (siteDisabled || requestId !== screenshotRequestSeq) {
      return;
    }
    const anchor = screenshotAnchor ?? ensureScreenshotAnchor({
      left: Math.max(0, window.innerWidth / 2 - 1),
      top: Math.max(0, window.innerHeight / 2 - 1),
      width: 2,
      height: 2
    });
    overlay?.showError(
      anchor,
      contentCopy[uiLocale()].screenshotTitle,
      error instanceof Error ? error.message : contentCopy[uiLocale()].recognitionFailed,
      true,
      true
    );
  }
}

async function requestScreenshotExplanation(
  selection: ScreenshotSelectionResult,
  anchor: HTMLElement,
  requestId: number,
  refresh: boolean
): Promise<void> {
  overlay?.showLoading(anchor, contentCopy[uiLocale()].recognizingScreenshot, true, !refresh, selection.pointer);
  const response = await chrome.runtime.sendMessage({
    type: "TERMPOP_RECOGNIZE_SCREENSHOT",
    termImageDataUrl: selection.termImageDataUrl,
    contextImageDataUrl: selection.contextImageDataUrl,
    url: location.href
  } satisfies RecognizeScreenshotRequest) as RecognizeScreenshotResponse;
  if (siteDisabled || requestId !== screenshotRequestSeq) {
    return;
  }
  if (!response.ok || !response.recognition) {
    overlay?.showError(
      anchor,
      contentCopy[uiLocale()].screenshotTitle,
      response.error ?? contentCopy[uiLocale()].recognitionFailed,
      true,
      !refresh,
      selection.pointer
    );
    return;
  }

  const { recognition } = response;
  pageExplanationCache.set(
    explanationResultCacheScope(recognition.term, recognition.context),
    recognition.explanation
  );
  overlay?.showExplanation(
    anchor,
    recognition.explanation,
    () => {
      const refreshRequestId = ++screenshotRequestSeq;
      void requestScreenshotExplanation(selection, anchor, refreshRequestId, true).catch((error: unknown) => {
        if (siteDisabled || refreshRequestId !== screenshotRequestSeq) {
          return;
        }
        overlay?.showError(
          anchor,
          recognition.term,
          error instanceof Error ? error.message : contentCopy[uiLocale()].recognitionFailed,
          true,
          false,
          selection.pointer
        );
      });
    },
    true,
    !refresh,
    selection.pointer
  );
}

function ensureScreenshotAnchor(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  if (!screenshotAnchor?.isConnected) {
    screenshotAnchor = document.createElement("span");
    screenshotAnchor.id = "termpop-screenshot-anchor";
    screenshotAnchor.dataset.termpopVirtualAnchor = "true";
    screenshotAnchor.dataset.termpopIgnore = "true";
    Object.assign(screenshotAnchor.style, {
      position: "fixed",
      pointerEvents: "none",
      opacity: "0",
      zIndex: "-1"
    });
    document.documentElement.append(screenshotAnchor);
  }
  Object.assign(screenshotAnchor.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${Math.max(1, rect.width)}px`,
    height: `${Math.max(1, rect.height)}px`
  });
  return screenshotAnchor;
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

function setupHighlightEventDelegation(): void {
  if (highlightEventsBound) {
    return;
  }

  highlightEventsBound = true;
  document.addEventListener(
    "pointerover",
    (event) => {
      if (siteDisabled) {
        return;
      }
      const highlight = closestHighlight(event.target);
      if (!highlight || isMovingInsideHighlight(highlight, event.relatedTarget)) {
        return;
      }

      const term = detectedTermFromHighlight(highlight);
      if (!term) {
        return;
      }

      scheduleHoverExplanation(highlight, term, contextForHighlight(highlight), event);
    },
    true
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      if (siteDisabled) {
        return;
      }
      const highlight = closestHighlight(event.target);
      if (!highlight || isMovingInsideHighlight(highlight, event.relatedTarget)) {
        return;
      }

      cancelHoverExplanation(highlight);
      overlay?.scheduleHide();
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (siteDisabled) {
        return;
      }
      const highlight = closestHighlight(event.target);
      if (!highlight) {
        return;
      }

      const term = detectedTermFromHighlight(highlight);
      if (!term) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      cancelHoverExplanation(highlight);
      void showExplanation(highlight, term, contextForHighlight(highlight), {
        refresh: false,
        pin: true,
        pointer: event
      });
    },
    true
  );
}

function closestHighlight(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  return target.closest<HTMLElement>(`.${HIGHLIGHT_CLASS}`) ?? undefined;
}

function isMovingInsideHighlight(highlight: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return relatedTarget instanceof Node && highlight.contains(relatedTarget);
}

function detectedTermFromHighlight(anchor: HTMLElement): DetectedTerm | undefined {
  const termText = (anchor.dataset.term || anchor.textContent || "").trim();
  if (!termText) {
    return undefined;
  }

  return {
    term: termText,
    start: 0,
    end: termText.length,
    term_type: normalizeTermType(anchor.dataset.termType),
    confidence: Number(anchor.dataset.confidence) || 1,
    source: "Dictionary"
  };
}

function contextForHighlight(anchor: HTMLElement): string {
  const scope = anchor.closest<HTMLElement>("p, li, article, section, main");
  const text = (scope?.innerText || anchor.parentElement?.innerText || document.body.innerText || anchor.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 1600);
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
  selectionAnchor.id = "termpop-selection-anchor";
  selectionAnchor.dataset.termpopVirtualAnchor = "true";
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
  if (siteDisabled) {
    return [];
  }
  try {
    debugLog("TermPop detect terms request", {
      detectionMode: debugOptions.detectionMode,
      disableCache: debugOptions.disableCache,
      textPreview: text
    });
    const response = await chrome.runtime.sendMessage({
      type: "TERMPOP_DETECT_TERMS",
      text,
      detectionMode: debugOptions.detectionMode,
      url: location.href,
      pageFingerprint: currentPageFingerprint()
    } satisfies DetectTermsRequest) as DetectTermsResponse;

    if (response.ok && response.terms) {
      debugLog("TermPop detect terms response", {
        count: response.terms.length,
        debug: response.debug,
        terms: response.terms.map((term) => term.term).slice(0, 20)
      });
      if (!debugOptions.disableCache) {
        mergeGlobalCachedTerms(response.terms);
      }
      return response.terms;
    }
    console.warn("TermPop detect terms failed response", sanitizeForLog(response, 300));
  } catch (error) {
    console.warn("TermPop detect terms request failed", sanitizeForLog(error, 300));
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
      type: "TERMPOP_GET_CACHED_TERMS",
      url: location.href,
      pageFingerprint: currentPageFingerprint()
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
    if (!isCachedTermAvailable(entry, {
      url: location.href,
      pageFingerprint: currentPageFingerprint()
    })) {
      continue;
    }
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
      type: "TERMPOP_ADD_CACHED_TERMS",
      terms: termsToFlush,
      url: location.href,
      pageFingerprint: currentPageFingerprint()
    } satisfies AddCachedTermsRequest);
  }, 500);
}

function mergeGlobalCachedTerms(terms: Array<DetectedTerm | CachedTermEntry>): void {
  if (debugOptions.disableCache) {
    return;
  }

  if (terms.length === 0) {
    return;
  }

  globalCachedTerms = mergeCachedTermView(globalCachedTerms, terms, {
    url: location.href,
    pageFingerprint: currentPageFingerprint()
  });
}

function readDebugOptions(): DebugOptions {
  const params = new URLSearchParams(window.location.search);
  const detectionMode = params.get("termpopDetection");
  return {
    detectionMode: detectionMode === "primary" || detectionMode === "llm" || detectionMode === "all"
      ? detectionMode
      : undefined,
    disableCache: params.get("termpopCache") === "0" || params.get("termpopNoCache") === "1"
  };
}

function debugLog(message: string, payload?: unknown): void {
  if (new URLSearchParams(window.location.search).get("termpopDebug") !== "1") {
    return;
  }
  console.info(message, sanitizeForLog(payload, 700));
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

function isHighlightableTextNode(node: Node): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }

  if (parent.closest(`.${HIGHLIGHT_CLASS}, #${ROOT_ID}`)) {
    return false;
  }

  const blocked = parent.closest([
    "a",
    "script",
    "style",
    "noscript",
    "code",
    "pre",
    "kbd",
    "samp",
    "var",
    "input",
    "textarea",
    "select",
    "option",
    "[role='textbox']",
    "[contenteditable='true']",
    "[data-termpop-ignore]",
    ".monaco-editor",
    ".cm-editor",
    ".ProseMirror"
  ].join(", "));
  if (blocked) {
    return false;
  }

  const style = window.getComputedStyle(parent);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function isTextNodeNearViewport(node: Text): boolean {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach();
  return rect.bottom >= -window.innerHeight * 0.2
    && rect.top <= window.innerHeight * 1.2
    && rect.right >= 0
    && rect.left <= window.innerWidth;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const requestIdleCallback = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (requestIdleCallback) {
      requestIdleCallback(() => resolve(), { timeout: 80 });
      return;
    }
    window.setTimeout(resolve, 0);
  });
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
    wrapper.dataset.confidence = String(term.confidence);
    wrapper.textContent = text.slice(term.start, term.end);
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
  pointer?: { clientX: number; clientY: number };
}
function scheduleHoverExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, pointer: MouseEvent | PointerEvent): void {
  cancelHoverExplanation(anchor);
  const timer = window.setTimeout(() => {
    hoverTimers.delete(anchor);
    hoverTimerIds.delete(timer);
    if (siteDisabled) {
      return;
    }
    if (!anchor.matches(":hover")) {
      return;
    }
    void showExplanation(anchor, term, context, { refresh: false, pin: false, pointer });
  }, HOVER_SHOW_DELAY_MS);
  hoverTimers.set(anchor, timer);
  hoverTimerIds.add(timer);
}

function cancelHoverExplanation(anchor: HTMLElement): void {
  const timer = hoverTimers.get(anchor);
  if (timer === undefined) {
    return;
  }
  window.clearTimeout(timer);
  hoverTimers.delete(anchor);
  hoverTimerIds.delete(timer);
}

async function showExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, options: ShowExplanationOptions): Promise<void> {
  if (siteDisabled) {
    return;
  }

  const requestId = ++explanationRequestSeq;
  explanationRequestIds.set(anchor, requestId);
  const cacheKey = explanationResultCacheScope(term.term, context);
  const cached = pageExplanationCache.get(cacheKey);
  if (cached && !options.refresh) {
    if (!isLatestExplanationRequest(anchor, requestId)) {
      return;
    }
    overlay?.showExplanation(anchor, cached, () => {
      void showExplanation(anchor, term, context, { refresh: true, pin: true });
    }, options.pin, true, options.pointer);
    return;
  }

  overlay?.showLoading(anchor, term.term, options.pin, !options.refresh, options.pointer);

  let response: ExplainResponse;
  try {
    response = await requestExplanation(term.term, context, cacheKey, options.refresh);
  } catch (error) {
    if (!isLatestExplanationRequest(anchor, requestId)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    overlay?.showError(anchor, term.term, message || contentCopy[uiLocale()].requestFailed, options.pin, !options.refresh, options.pointer);
    return;
  }

  if (!isLatestExplanationRequest(anchor, requestId)) {
    return;
  }

  if (!response.ok || !response.explanation) {
    overlay?.showError(anchor, term.term, response.error ?? contentCopy[uiLocale()].unavailable, options.pin, !options.refresh, options.pointer);
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

function isLatestExplanationRequest(anchor: HTMLElement, requestId: number): boolean {
  return explanationRequestIds.get(anchor) === requestId;
}

function requestExplanation(term: string, context: string, cacheKey: string, refresh: boolean): Promise<ExplainResponse> {
  if (siteDisabled) {
    return Promise.resolve({ ok: false, error: "TermPop is disabled on this site." });
  }

  if (!refresh) {
    const pending = pendingExplanationRequests.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const request = chrome.runtime.sendMessage({
    type: "TERMPOP_EXPLAIN",
    term,
    context,
    cacheScope: cacheKey,
    url: location.href,
    pageFingerprint: currentPageFingerprint(),
    refresh
  } satisfies ExplainRequest) as Promise<ExplainResponse>;

  pendingExplanationRequests.set(cacheKey, request);
  void request.finally(() => {
    if (pendingExplanationRequests.get(cacheKey) === request) {
      pendingExplanationRequests.delete(cacheKey);
    }
  });
  return request;
}

const contentCopy = {
  zh: {
    requestFailed: "解释请求失败。",
    unavailable: "暂时无法解释这个词。",
    screenshotTitle: "截图识词",
    recognizingScreenshot: "正在识别框选内容...",
    recognitionFailed: "无法从框选内容中识别词汇。"
  },
  en: {
    requestFailed: "Explanation request failed.",
    unavailable: "This term cannot be explained right now.",
    screenshotTitle: "Screenshot recognition",
    recognizingScreenshot: "Recognizing the selected area...",
    recognitionFailed: "No term could be identified in the selected area."
  }
} as const;

function uiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? navigator.language;
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}

function explanationCacheKey(term: string): string {
  return term.trim().toLocaleLowerCase();
}

function currentPageFingerprint(): string {
  const now = Date.now();
  if (cachedPageFingerprint && cachedPageFingerprint.url === location.href && now - cachedPageFingerprint.at < 10_000) {
    return cachedPageFingerprint.value;
  }
  cachedPageFingerprint = {
    value: pageFingerprintFromUrlAndText(location.href, document.body.innerText || document.body.textContent || ""),
    at: now,
    url: location.href
  };
  return cachedPageFingerprint.value;
}
