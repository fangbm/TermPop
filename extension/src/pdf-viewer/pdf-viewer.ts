import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type {
  DetectTermsRequest,
  DetectTermsResponse,
  DetectTermsDebug,
  DetectedTerm,
  ExplainRequest,
  ExplainResponse,
  Explanation
} from "../shared/types";
import { TermPopOverlayController } from "../shared/overlay";
import { filterAllowedDetectedTerms } from "../shared/term-matching";
import { pageFingerprintFromUrlAndText, sanitizeForLog } from "../shared/browser-utils";
import "../shared/overlay.css";
import "./pdf-viewer.css";

type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

type TextLayerItem = {
  text: string;
  start: number;
  end: number;
  element: HTMLElement;
  offset: number;
};

type HighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PdfPageState = {
  pageNumber: number;
  pdf: pdfjsLib.PDFDocumentProxy;
  page?: pdfjsLib.PDFPageProxy;
  pagePromise?: Promise<pdfjsLib.PDFPageProxy>;
  pageEl: HTMLElement;
  renderState: "placeholder" | "rendering" | "rendered" | "failed";
  primaryState: "pending" | "running" | "done" | "failed";
  primaryCount: number;
  llmState: "pending" | "running" | "done" | "failed";
  llmAdded: number;
  llmError?: string;
  pageText?: string;
  textItems?: TextLayerItem[];
  highlightLayer?: HTMLElement;
  primaryTerms?: DetectedTerm[];
};

type LlmPageResult = {
  renderedCount: number;
  debug?: DetectTermsDebug;
};

const root = document.querySelector<HTMLDivElement>("#pdf-root");
const status = document.querySelector<HTMLParagraphElement>("#viewer-status");
const reloadButton = document.querySelector<HTMLButtonElement>("#reload-button");
const uiLocale = getUiLocale();
const sourceUrl = new URLSearchParams(location.search).get("src") ?? "";
const renderScale = Math.max(1.25, Math.min(window.devicePixelRatio || 1, 2));
const HOVER_SHOW_DELAY_MS = 420;
const HIGHLIGHT_CLASS = "pdf-highlight";
const ROOT_ID = "termpop-overlay-root";
const SETTINGS_KEY = "termpop.settings";
const LLM_PAGE_DELAY_MS = 700;
const LLM_NEARBY_PAGE_RADIUS = 1;
const LLM_VIEWPORT_SCHEDULE_DELAY_MS = 250;
const DEFAULT_PAGE_WIDTH = 612;
const DEFAULT_PAGE_HEIGHT = 792;
const hoverTimers = new WeakMap<HTMLElement, number>();
const pageExplanationCache = new Map<string, Explanation>();
let lastDetectionDebug: DetectTermsDebug | undefined;
let activePdfPageStates: PdfPageState[] = [];
let activePrimaryCount = 0;
let renderedPageCount = 0;
let renderSchedulerTimer: number | undefined;
let llmSchedulerTimer: number | undefined;
let llmQueueRunning = false;
let pageObserver: IntersectionObserver | undefined;
const pageStateByElement = new WeakMap<Element, PdfPageState>();
const overlay = new TermPopOverlayController({
  rootId: ROOT_ID,
  anchorSelector: `.${HIGHLIGHT_CLASS}`,
  locale: uiLocale
});

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

reloadButton?.addEventListener("click", () => {
  void renderPdf();
});

window.addEventListener("scroll", () => {
  scheduleViewportPageRendering();
  scheduleViewportLlmDetection();
}, { passive: true });
window.addEventListener("resize", () => {
  scheduleViewportPageRendering();
  scheduleViewportLlmDetection();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    pageExplanationCache.clear();
  }
});

void renderPdf();

async function renderPdf(): Promise<void> {
  if (!root) return;
  root.innerHTML = "";
  overlay.hide();
  pageObserver?.disconnect();
  pageObserver = undefined;
  activePdfPageStates = [];
  activePrimaryCount = 0;
  renderedPageCount = 0;
  llmQueueRunning = false;
  if (renderSchedulerTimer !== undefined) {
    window.clearTimeout(renderSchedulerTimer);
    renderSchedulerTimer = undefined;
  }
  if (llmSchedulerTimer !== undefined) {
    window.clearTimeout(llmSchedulerTimer);
    llmSchedulerTimer = undefined;
  }

  if (!sourceUrl) {
    setStatus(pdfCopy[uiLocale].missingSource);
    return;
  }

  try {
    setStatus(pdfCopy[uiLocale].loadingPdf);
    const documentTask = pdfjsLib.getDocument({ url: sourceUrl });
    const pdf = await documentTask.promise;
    setStatus(format(pdfCopy[uiLocale].creatingPlaceholders, { total: pdf.numPages }));
    pageObserver = new IntersectionObserver(handlePageIntersections, {
      root: null,
      rootMargin: "900px 0px",
      threshold: 0.01
    });

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      activePdfPageStates.push(createPagePlaceholder(pdf, pageNumber));
    }

    setStatus(buildPdfStatus(pdfCopy[uiLocale].viewportFirst));
    scheduleViewportPageRendering();
  } catch (error) {
    setStatus(format(pdfCopy[uiLocale].loadFailed, { error: error instanceof Error ? error.message : String(error) }));
  }
}

function createPagePlaceholder(pdf: pdfjsLib.PDFDocumentProxy, pageNumber: number): PdfPageState {
  const pageEl = document.createElement("section");
  pageEl.className = "pdf-page";
  pageEl.dataset.pageNumber = String(pageNumber);
  pageEl.style.width = `${DEFAULT_PAGE_WIDTH * renderScale}px`;
  pageEl.style.height = `${DEFAULT_PAGE_HEIGHT * renderScale}px`;
  pageEl.dataset.placeholder = "true";
  pageEl.style.setProperty("--total-scale-factor", String(renderScale));
  root?.append(pageEl);

  const state: PdfPageState = {
    pageNumber,
    pdf,
    pageEl,
    renderState: "placeholder",
    primaryState: "pending",
    primaryCount: 0,
    llmState: "pending",
    llmAdded: 0
  };
  pageStateByElement.set(pageEl, state);
  pageObserver?.observe(pageEl);
  return state;
}

async function renderPageState(state: PdfPageState): Promise<void> {
  if (state.renderState !== "placeholder") {
    return;
  }

  state.renderState = "rendering";
  state.primaryState = "running";
  setStatus(buildPdfStatus(format(pdfCopy[uiLocale].renderingPage, { page: state.pageNumber })));

  try {
    const page = await loadPage(state);
    const viewport = page.getViewport({ scale: renderScale });
    state.pageEl.style.width = `${viewport.width}px`;
    state.pageEl.style.height = `${viewport.height}px`;
    state.pageEl.dataset.placeholder = "false";
    state.pageEl.replaceChildren();

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    state.pageEl.append(canvas);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "pdf-highlight-layer";
    state.pageEl.append(highlightLayer);

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer pdf-text-layer";
    state.pageEl.append(textLayerEl);

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(pdfCopy[uiLocale].canvasFailed);
    }

    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport
    });
    await textLayer.render();
    const textItems = buildTextLayerItems(textContent.items as TextItem[], textLayer.textDivs);
    const pageText = textItems.map((item) => item.text).join(" ");
    const primaryTerms = filterAllowedDetectedTerms(pageText, await detectTerms(pageText, "primary"));
    const primaryCount = drawHighlights(state.pageEl, highlightLayer, textItems, primaryTerms, pageText, state.pageNumber);

    state.renderState = "rendered";
    state.primaryState = "done";
    state.highlightLayer = highlightLayer;
    state.textItems = textItems;
    state.pageText = pageText;
    state.primaryTerms = primaryTerms;
    state.primaryCount = primaryCount;
    renderedPageCount += 1;
    activePrimaryCount += primaryCount;
    setStatus(buildPdfStatus(format(pdfCopy[uiLocale].pagePrimaryDone, { page: state.pageNumber, count: primaryCount })));
    scheduleViewportLlmDetection();
  } catch (error) {
    state.renderState = "failed";
    state.primaryState = "failed";
    console.warn("TermPop PDF page render failed", sanitizeForLog(error, 300));
    setStatus(buildPdfStatus(format(pdfCopy[uiLocale].pageRenderFailed, { page: state.pageNumber, error: truncateStatus(error instanceof Error ? error.message : String(error)) })));
  }
}

async function loadPage(state: PdfPageState): Promise<pdfjsLib.PDFPageProxy> {
  if (state.page) {
    return state.page;
  }
  state.pagePromise ??= state.pdf.getPage(state.pageNumber);
  state.page = await state.pagePromise;
  return state.page;
}

function handlePageIntersections(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }
    const state = pageStateByElement.get(entry.target);
    if (state) {
      void renderPageState(state);
    }
  }
}

function scheduleViewportPageRendering(): void {
  if (renderSchedulerTimer !== undefined) {
    window.clearTimeout(renderSchedulerTimer);
  }
  renderSchedulerTimer = window.setTimeout(() => {
    renderSchedulerTimer = undefined;
    for (const state of getViewportNearbyPages()) {
      void renderPageState(state);
    }
  }, 80);
}

function getViewportNearbyPages(): PdfPageState[] {
  const viewportTop = -window.innerHeight;
  const viewportBottom = window.innerHeight * 2;
  return activePdfPageStates.filter((state) => {
    const rect = state.pageEl.getBoundingClientRect();
    return rect.bottom >= viewportTop && rect.top <= viewportBottom;
  });
}

async function runLlmForPage(pageState: PdfPageState): Promise<LlmPageResult> {
  if (
    pageState.renderState !== "rendered"
    || !pageState.pageText
    || !pageState.textItems
    || !pageState.highlightLayer
    || !pageState.primaryTerms
  ) {
    return { renderedCount: 0 };
  }

  const terms = await detectTerms(pageState.pageText, "llm");
  const llmTerms = filterNonOverlappingTerms(filterAllowedDetectedTerms(pageState.pageText, terms), pageState.primaryTerms);
  return {
    renderedCount: drawHighlights(pageState.pageEl, pageState.highlightLayer, pageState.textItems, llmTerms, pageState.pageText, pageState.pageNumber),
    debug: lastDetectionDebug
  };
}

function scheduleViewportLlmDetection(): void {
  if (activePdfPageStates.length === 0) {
    return;
  }

  if (llmSchedulerTimer !== undefined) {
    window.clearTimeout(llmSchedulerTimer);
  }

  llmSchedulerTimer = window.setTimeout(() => {
    llmSchedulerTimer = undefined;
    void runViewportLlmQueue();
  }, LLM_VIEWPORT_SCHEDULE_DELAY_MS);
}

async function runViewportLlmQueue(): Promise<void> {
  if (llmQueueRunning) {
    return;
  }

  const queue = getViewportNearbyPendingPages();
  if (queue.length === 0) {
    return;
  }

  llmQueueRunning = true;
  try {
    for (const pageState of queue) {
      if (pageState.llmState !== "pending") {
        continue;
      }
      pageState.llmState = "running";
      setStatus(buildPdfStatus(format(pdfCopy[uiLocale].llmRunning, { page: pageState.pageNumber })));
      try {
        const result = await runLlmForPage(pageState);
        pageState.llmState = "done";
        pageState.llmAdded = result.renderedCount;
        mergeDetectionDebug(lastDetectionDebug ?? {}, result.debug);
        setStatus(buildPdfStatus(format(pdfCopy[uiLocale].llmDone, { page: pageState.pageNumber, count: result.renderedCount })));
      } catch (error) {
        pageState.llmState = "failed";
        pageState.llmError = error instanceof Error ? error.message : String(error);
        console.warn("TermPop PDF LLM detection failed", sanitizeForLog(error, 300));
        setStatus(buildPdfStatus(format(pdfCopy[uiLocale].llmFailed, { page: pageState.pageNumber, error: truncateStatus(pageState.llmError) })));
      }
      await sleep(LLM_PAGE_DELAY_MS);
    }
  } finally {
    llmQueueRunning = false;
  }
}

function getViewportNearbyPendingPages(): PdfPageState[] {
  const visiblePages = getVisiblePdfPages();
  const anchorPages = visiblePages.length > 0 ? visiblePages : getClosestPdfPage() ? [getClosestPdfPage() as PdfPageState] : [];
  const wantedNumbers = new Set<number>();

  for (const page of anchorPages) {
    for (let offset = -LLM_NEARBY_PAGE_RADIUS; offset <= LLM_NEARBY_PAGE_RADIUS; offset += 1) {
      wantedNumbers.add(page.pageNumber + offset);
    }
  }

  const viewportCenter = window.innerHeight / 2;
  return activePdfPageStates
    .filter((page) => page.renderState === "rendered" && page.llmState === "pending" && wantedNumbers.has(page.pageNumber))
    .sort((left, right) => distanceToViewportCenter(left.pageEl, viewportCenter) - distanceToViewportCenter(right.pageEl, viewportCenter));
}

function getVisiblePdfPages(): PdfPageState[] {
  return activePdfPageStates.filter((page) => {
    const rect = page.pageEl.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= window.innerHeight;
  });
}

function getClosestPdfPage(): PdfPageState | undefined {
  const viewportCenter = window.innerHeight / 2;
  return [...activePdfPageStates].sort((left, right) => distanceToViewportCenter(left.pageEl, viewportCenter) - distanceToViewportCenter(right.pageEl, viewportCenter))[0];
}

function distanceToViewportCenter(element: HTMLElement, viewportCenter: number): number {
  const rect = element.getBoundingClientRect();
  return Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
}

function buildPdfStatus(detail: string): string {
  const total = activePdfPageStates.length;
  const rendered = activePdfPageStates.filter((page) => page.renderState === "rendered").length;
  const done = activePdfPageStates.filter((page) => page.llmState === "done").length;
  const failed = activePdfPageStates.filter((page) => page.llmState === "failed").length;
  const added = activePdfPageStates.reduce((sum, page) => sum + page.llmAdded, 0);
  return format(pdfCopy[uiLocale].statusSummary, {
    total,
    rendered: renderedPageCount || rendered,
    primary: activePrimaryCount,
    done,
    renderedMax: Math.max(rendered, 1),
    added,
    failedText: failed ? format(pdfCopy[uiLocale].failedSuffix, { failed }) : "",
    detail
  });
}

function buildTextLayerItems(items: TextItem[], textDivs: HTMLElement[]): TextLayerItem[] {
  const indexedItems: TextLayerItem[] = [];
  let cursor = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const element = textDivs[index];
    if (!element) continue;
    const rawText = item.str;

    const text = rawText.trim();
    if (!text) continue;

    if (isRotatedTextElement(element)) {
      continue;
    }

    const start = cursor;
    const end = start + text.length;
    indexedItems.push({
      text,
      start,
      end,
      element,
      offset: rawText.length - rawText.trimStart().length
    });
    cursor = end + 1;
  }

  return indexedItems;
}

function isRotatedTextElement(element: HTMLElement): boolean {
  const transform = window.getComputedStyle(element).transform;
  if (!transform || transform === "none") {
    return false;
  }

  const match = transform.match(/^matrix\(([^,]+),\s*([^,]+)/);
  if (!match) {
    return false;
  }

  const scaleX = Number(match[1]);
  const skewY = Number(match[2]);
  if (!Number.isFinite(scaleX) || !Number.isFinite(skewY)) {
    return false;
  }

  return Math.abs(Math.atan2(skewY, scaleX)) > 0.25;
}

async function detectTerms(text: string, detectionMode: DetectTermsRequest["detectionMode"] = "all"): Promise<DetectedTerm[]> {
  if (!text.trim()) {
    return [];
  }
  const response = await chrome.runtime.sendMessage({
    type: "TERMPOP_DETECT_TERMS",
    text,
    detectionMode,
    url: sourceUrl,
    pageFingerprint: pageFingerprintFromUrlAndText(sourceUrl, text)
  } satisfies DetectTermsRequest) as DetectTermsResponse;

  if (!response.ok) {
    throw new Error(response.error || pdfCopy[uiLocale].detectFailed);
  }
  lastDetectionDebug = response.debug;
  return response.terms ?? [];
}

function filterNonOverlappingTerms(terms: DetectedTerm[], existingTerms: DetectedTerm[]): DetectedTerm[] {
  return terms.filter((term) => !existingTerms.some((existing) => rangesOverlap(existing.start, existing.end, term.start, term.end)));
}

function drawHighlights(
  pageEl: HTMLElement,
  layer: HTMLElement,
  textItems: TextLayerItem[],
  terms: DetectedTerm[],
  pageText: string,
  pageNumber: number
): number {
  let count = 0;
  const limitedTerms = terms.slice(0, 80);
  for (const term of limitedTerms) {
    for (const item of textItems) {
      if (!rangesOverlap(term.start, term.end, item.start, item.end)) continue;

      const rects = getHighlightRects(pageEl, term, item);

      for (const rect of rects) {
        const highlight = document.createElement("button");
        highlight.type = "button";
        highlight.className = HIGHLIGHT_CLASS;
        highlight.dataset.termType = term.term_type;
        highlight.style.left = `${rect.left}px`;
        highlight.style.top = `${rect.top}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
        highlight.title = term.term;
        highlight.addEventListener("mouseenter", (event) => {
          scheduleHoverExplanation(highlight, term, pageText, pageNumber, event);
        });
        highlight.addEventListener("mouseleave", () => {
          cancelHoverExplanation(highlight);
          overlay.scheduleHide();
        });
        highlight.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          cancelHoverExplanation(highlight);
          void showExplanation(highlight, term, pageText, pageNumber, false, true, event);
        });
        layer.append(highlight);
        count += 1;
      }
    }
  }
  return count;
}

function getHighlightRects(pageEl: HTMLElement, term: DetectedTerm, item: TextLayerItem): HighlightRect[] {
  const startInItem = Math.max(0, term.start - item.start);
  const endInItem = Math.min(item.text.length, term.end - item.start);
  const selectedLength = endInItem - startInItem;
  if (selectedLength <= 0 || (term.term.trim().length > 1 && selectedLength === 1 && item.text.length > 1)) {
    return [];
  }

  const textNode = item.element.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return [];
  }

  const textLength = textNode.textContent?.length ?? 0;
  const startOffset = clamp(item.offset + startInItem, 0, textLength);
  const endOffset = clamp(item.offset + endInItem, startOffset, textLength);
  if (startOffset === endOffset) {
    return [];
  }

  const range = document.createRange();
  range.setStart(textNode, startOffset);
  range.setEnd(textNode, endOffset);
  const pageRect = pageEl.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .map((rect) => ({
      left: rect.left - pageRect.left,
      top: rect.top - pageRect.top,
      width: rect.width,
      height: rect.height
    }))
    .filter(isUsableHighlightRect);
  range.detach();
  return rects;
}

function isUsableHighlightRect(rect: HighlightRect): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && rect.width >= 2
    && rect.height >= 4
    && rect.height <= Math.max(28, rect.width * 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function scheduleHoverExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, pageNumber: number, pointer: MouseEvent): void {
  cancelHoverExplanation(anchor);
  const timer = window.setTimeout(() => {
    hoverTimers.delete(anchor);
    if (!anchor.matches(":hover")) {
      return;
    }
    void showExplanation(anchor, term, context, pageNumber, false, false, pointer);
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

async function showExplanation(anchor: HTMLElement, term: DetectedTerm, context: string, pageNumber: number, refresh = false, pin = false, pointer?: MouseEvent | PointerEvent): Promise<void> {
  const cacheKey = explanationResultCacheKey(term.term, context, pageNumber);
  const cached = pageExplanationCache.get(cacheKey);
  if (cached && !refresh) {
    overlay.showExplanation(anchor, cached, () => {
      void showExplanation(anchor, term, context, pageNumber, true, true);
    }, pin, true, pointer);
    return;
  }

  overlay.showLoading(anchor, term.term, pin || refresh, !refresh, pointer);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TERMPOP_EXPLAIN",
      term: term.term,
      context: context.slice(0, 1600),
      cacheScope: `${sourceUrl}\npage=${pageNumber}\n${pageFingerprintFromUrlAndText(sourceUrl, context)}`,
      url: sourceUrl,
      pageFingerprint: pageFingerprintFromUrlAndText(sourceUrl, context),
      refresh
    } satisfies ExplainRequest) as ExplainResponse;

    if (!response.ok || !response.explanation) {
      throw new Error(response.error || pdfCopy[uiLocale].explainFailed);
    }
    pageExplanationCache.set(cacheKey, response.explanation);
    if (!pin && !refresh && !anchor.matches(":hover") && !overlay.isPointerOverCard()) {
      return;
    }
    overlay.showExplanation(anchor, response.explanation, () => {
      void showExplanation(anchor, term, context, pageNumber, true, true);
    }, pin || refresh, !refresh, pointer);
  } catch (error) {
    overlay.showError(anchor, term.term, error instanceof Error ? error.message : String(error), pin || refresh, !refresh, pointer);
  }
}

function explanationResultCacheKey(term: string, context: string, pageNumber: number): string {
  return `${pageNumber}\n${term.trim().toLocaleLowerCase()}\n${hashString(context.replace(/\s+/g, " ").trim().slice(0, 1200))}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function mergeDetectionDebug(target: DetectTermsDebug, source: DetectTermsDebug | undefined): void {
  if (!source) {
    return;
  }

  target.rawCandidateCount = (target.rawCandidateCount ?? 0) + (source.rawCandidateCount ?? 0);
  target.matchedCount = (target.matchedCount ?? 0) + (source.matchedCount ?? 0);
  target.rejectedCount = (target.rejectedCount ?? 0) + (source.rejectedCount ?? 0);
  target.unmatchedCount = (target.unmatchedCount ?? 0) + (source.unmatchedCount ?? 0);
  target.chunkCount = (target.chunkCount ?? 0) + (source.chunkCount ?? 0);
  target.sampleCandidates = [...target.sampleCandidates ?? [], ...source.sampleCandidates ?? []].slice(0, 12);
  target.sampleMatchedTerms = [...target.sampleMatchedTerms ?? [], ...source.sampleMatchedTerms ?? []].slice(0, 12);
}

function truncateStatus(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

const pdfCopy = {
  zh: {
    missingSource: "缺少 PDF 地址。",
    loadingPdf: "正在加载 PDF...",
    creatingPlaceholders: "已加载 {total} 页，正在创建页面占位...",
    createdPlaceholder: "已加载 {total} 页，已创建占位 {page}/{total} 页。",
    viewportFirst: "当前视口附近页面会优先渲染和识别。",
    loadFailed: "PDF 加载失败：{error}",
    renderingPage: "正在渲染第 {page} 页...",
    canvasFailed: "无法创建 PDF Canvas。",
    pagePrimaryDone: "第 {page} 页词表高亮 {count} 处。",
    pageRenderFailed: "第 {page} 页渲染失败：{error}",
    llmRunning: "LLM 正在补充第 {page} 页...",
    llmDone: "LLM 已补充第 {page} 页，新增 {count} 处。",
    llmFailed: "LLM 第 {page} 页失败：{error}",
    statusSummary: "已加载 {total} 页，已渲染 {rendered}/{total} 页，词表高亮 {primary} 处；LLM 补词 {done}/{renderedMax} 页，新增 {added} 处{failedText}。{detail}",
    failedSuffix: "，失败 {failed} 页",
    detectFailed: "术语识别失败",
    explainFailed: "解释生成失败"
  },
  en: {
    missingSource: "Missing PDF source.",
    loadingPdf: "Loading PDF...",
    creatingPlaceholders: "Loaded {total} pages, creating page placeholders...",
    createdPlaceholder: "Loaded {total} pages, created placeholder {page}/{total}.",
    viewportFirst: "Pages near the current viewport are rendered and detected first.",
    loadFailed: "PDF load failed: {error}",
    renderingPage: "Rendering page {page}...",
    canvasFailed: "Could not create PDF canvas.",
    pagePrimaryDone: "Page {page}: {count} dictionary highlights.",
    pageRenderFailed: "Page {page} render failed: {error}",
    llmRunning: "LLM is enriching page {page}...",
    llmDone: "LLM enriched page {page}, added {count} highlights.",
    llmFailed: "LLM failed on page {page}: {error}",
    statusSummary: "Loaded {total} pages, rendered {rendered}/{total}, dictionary highlights {primary}; LLM pages {done}/{renderedMax}, added {added}{failedText}. {detail}",
    failedSuffix: ", failed {failed}",
    detectFailed: "Term detection failed",
    explainFailed: "Explanation generation failed"
  }
} as const;

function getUiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? navigator.language;
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}
