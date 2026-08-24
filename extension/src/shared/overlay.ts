import type { Explanation, FollowUpTurn } from "./types";
import { resolveOverlayLayer } from "./stacking-layer";

export interface OverlayOptions {
  rootId: string;
  anchorSelector: string;
  locale?: "zh" | "en";
}

export interface OverlayPointer {
  clientX: number;
  clientY: number;
}

interface Point {
  x: number;
  y: number;
}

export class TermPopOverlayController {
  private readonly root: HTMLDivElement;
  private readonly anchorSelector: string;
  private readonly locale: "zh" | "en";
  private hideTimer: number | undefined;
  private repositionFrame: number | undefined;
  private currentAnchor: HTMLElement | undefined;
  private anchorPoint: Point | undefined;
  private initialPlacement: "above" | "below" | undefined;
  private pinned = false;
  private pointerOverCard = false;

  constructor(options: OverlayOptions) {
    this.anchorSelector = options.anchorSelector;
    this.locale = options.locale ?? uiLocale();
    this.root = document.createElement("div");
    this.root.id = options.rootId;
    Object.assign(this.root.style, {
      position: "fixed",
      zIndex: "1",
      display: "none",
      width: "min(340px, calc(100vw - 24px))"
    });
    this.root.addEventListener("mouseenter", () => {
      this.pointerOverCard = true;
      this.cancelHide();
    });
    this.root.addEventListener("mouseleave", () => {
      this.pointerOverCard = false;
      this.scheduleHide();
    });
    document.addEventListener("pointerdown", (event) => this.handleDocumentPointerDown(event), true);
    window.addEventListener("scroll", () => this.scheduleReposition(), true);
    document.addEventListener("scroll", () => this.scheduleReposition(), true);
    window.addEventListener("resize", () => this.scheduleReposition());
    document.documentElement.append(this.root);
  }

  showLoading(anchor: HTMLElement, term: string, keepVisible = false, resetPlacement = false, pointer?: OverlayPointer): void {
    this.render(anchor, `<div class="termpop-card-title">${escapeHtml(term)}</div><div class="termpop-muted">${escapeHtml(copy[this.locale].loading)}</div>`, keepVisible, resetPlacement, pointer);
  }

  showError(anchor: HTMLElement, term: string, message: string, keepVisible = false, resetPlacement = false, pointer?: OverlayPointer): void {
    this.render(
      anchor,
      `<div class="termpop-card-title">${escapeHtml(term)}</div><div class="termpop-error">${escapeHtml(message)}</div>`,
      keepVisible,
      resetPlacement,
      pointer
    );
  }

  showExplanation(
    anchor: HTMLElement,
    explanation: Explanation,
    onRefresh: () => void,
    keepVisible = false,
    resetPlacement = false,
    pointer?: OverlayPointer,
    onDelete?: () => void,
    onFollowUp?: (question: string, history: FollowUpTurn[]) => Promise<string>
  ): void {
    const related = explanation.related_terms.map((term) => `<span>${escapeHtml(term)}</span>`).join("");
    this.render(
      anchor,
      `<div class="termpop-card-header">
         <div class="termpop-card-title">${escapeHtml(explanation.term)}</div>
         <div class="termpop-card-actions">
           ${onDelete ? `<button class="termpop-delete-button" type="button" title="${escapeHtml(copy[this.locale].delete)}" aria-label="${escapeHtml(copy[this.locale].delete)}">${escapeHtml(copy[this.locale].delete)}</button>` : ""}
           <button class="termpop-refresh-button" type="button" title="${escapeHtml(copy[this.locale].refresh)}" aria-label="${escapeHtml(copy[this.locale].refresh)}">↻</button>
         </div>
       </div>
        <div class="termpop-category">${escapeHtml(explanation.category)}</div>
        <div class="termpop-definition">${escapeHtml(explanation.definition)}</div>
       ${explanation.usage_example ? `<div class="termpop-example">${escapeHtml(explanation.usage_example)}</div>` : ""}
       <div class="termpop-related">${related}</div>
       ${onFollowUp ? this.followUpComposerHtml() : ""}`,
      keepVisible,
      resetPlacement,
      pointer
    );
    this.root.querySelector<HTMLButtonElement>(".termpop-refresh-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.pin();
      onRefresh();
    });
    this.root.querySelector<HTMLButtonElement>(".termpop-delete-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (onDelete) {
        this.showDeleteConfirmation(anchor, explanation, onRefresh, onDelete, pointer);
      }
    });
    if (onFollowUp) {
      this.bindFollowUpComposer(explanation, onFollowUp);
    }
  }

  private showDeleteConfirmation(
    anchor: HTMLElement,
    explanation: Explanation,
    onRefresh: () => void,
    onDelete: () => void,
    pointer?: OverlayPointer
  ): void {
    this.render(
      anchor,
      `<div class="termpop-card-title">${escapeHtml(explanation.term)}</div>
       <div class="termpop-delete-confirmation">
         <p>${escapeHtml(copy[this.locale].deleteConfirmation(explanation.term))}</p>
         <div class="termpop-confirm-actions">
           <button class="termpop-cancel-delete-button" type="button">${escapeHtml(copy[this.locale].cancel)}</button>
           <button class="termpop-confirm-delete-button" type="button">${escapeHtml(copy[this.locale].confirmDelete)}</button>
         </div>
       </div>`,
      true,
      false,
      pointer
    );
    this.root.querySelector<HTMLButtonElement>(".termpop-cancel-delete-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showExplanation(anchor, explanation, onRefresh, true, false, pointer, onDelete);
    });
    this.root.querySelector<HTMLButtonElement>(".termpop-confirm-delete-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDelete();
    });
  }

  scheduleHide(): void {
    if (this.pinned) {
      return;
    }
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => {
      if (this.pointerOverCard || this.currentAnchor?.matches(":hover")) {
        return;
      }
      this.hide();
    }, 220);
  }

  hide(): void {
    this.pinned = false;
    this.cancelHide();
    this.root.classList.remove("is-visible");
    this.root.style.display = "none";
    this.pointerOverCard = false;
    this.currentAnchor = undefined;
    this.anchorPoint = undefined;
    this.initialPlacement = undefined;
    this.unlockFollowUpSize();
    this.restoreDefaultContainer();
  }

  isPointerOverCard(): boolean {
    return this.pointerOverCard;
  }

  private pin(): void {
    this.pinned = true;
    this.cancelHide();
  }

  private handleDocumentPointerDown(event: PointerEvent): void {
    if (!this.root.classList.contains("is-visible")) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (this.root.contains(target)) {
      return;
    }

    if (target instanceof Element && target.closest(this.anchorSelector)) {
      return;
    }

    this.hide();
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  private render(anchor: HTMLElement, html: string, keepVisible = false, resetPlacement = false, pointer?: OverlayPointer): void {
    this.unlockFollowUpSize();
    this.pinned = keepVisible;
    if (this.currentAnchor !== anchor || resetPlacement) {
      this.initialPlacement = undefined;
    }
    this.currentAnchor = anchor;
    if (pointer) {
      this.anchorPoint = { x: pointer.clientX, y: pointer.clientY };
    }
    this.cancelHide();
    this.syncLayer(anchor);
    this.root.innerHTML = `<div class="termpop-card">${html}</div>`;
    this.root.classList.add("is-visible");
    this.root.style.display = "block";
    this.positionNearAnchor();
  }

  private scheduleReposition(): void {
    if (!this.root.classList.contains("is-visible") && !this.pinned) {
      return;
    }
    if (this.repositionFrame !== undefined) {
      return;
    }
    this.repositionFrame = window.requestAnimationFrame(() => {
      this.repositionFrame = undefined;
      this.positionNearAnchor();
    });
  }

  private positionNearAnchor(): void {
    const anchor = this.currentAnchor;
    if (!anchor?.isConnected) {
      this.hide();
      return;
    }

    this.syncLayer(anchor);

    const anchorRect = getBestAnchorRect(anchor, this.anchorPoint);
    if (!isRectInViewport(anchorRect)) {
      this.root.classList.remove("is-visible");
      this.root.style.display = "none";
      return;
    }

    this.root.classList.add("is-visible");
    this.root.style.display = "block";
    const cardRect = this.root.getBoundingClientRect();
    const left = clamp(anchorRect.left + anchorRect.width / 2 - cardRect.width / 2, 12, Math.max(12, window.innerWidth - cardRect.width - 12));
    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    this.initialPlacement ??= anchorCenterY < window.innerHeight / 2 ? "below" : "above";
    const belowTop = anchorRect.bottom + 10;
    const aboveTop = anchorRect.top - cardRect.height - 10;
    const canFitBelow = belowTop + cardRect.height <= window.innerHeight - 12;
    const canFitAbove = aboveTop >= 12;
    const activePlacement = this.resolvePlacement(canFitAbove, canFitBelow);
    let top = activePlacement === "below" ? belowTop : aboveTop;

    top = clamp(top, 12, Math.max(12, window.innerHeight - cardRect.height - 12));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  private syncLayer(anchor: HTMLElement): void {
    const layer = resolveOverlayLayer(anchor, this.root, this.anchorPoint);
    if (this.root.parentElement !== layer.container) {
      layer.container.append(this.root);
    }
    this.root.style.zIndex = String(layer.zIndex);
  }

  private restoreDefaultContainer(): void {
    if (this.root.parentElement !== document.documentElement) {
      document.documentElement.append(this.root);
    }
    this.root.style.zIndex = "1";
  }

  private followUpComposerHtml(): string {
    return `<div class="termpop-follow-up">
      <div class="termpop-follow-up-history" aria-live="polite"></div>
      <div class="termpop-follow-up-error" role="alert"></div>
      <div class="termpop-follow-up-composer">
        <textarea class="termpop-follow-up-input" rows="1" placeholder="${escapeHtml(copy[this.locale].followUpPlaceholder)}" aria-label="${escapeHtml(copy[this.locale].followUpPlaceholder)}"></textarea>
        <button class="termpop-follow-up-send" type="button" disabled>${escapeHtml(copy[this.locale].send)}</button>
      </div>
    </div>`;
  }

  private bindFollowUpComposer(explanation: Explanation, onFollowUp: (question: string, history: FollowUpTurn[]) => Promise<string>): void {
    const input = this.root.querySelector<HTMLTextAreaElement>(".termpop-follow-up-input");
    const send = this.root.querySelector<HTMLButtonElement>(".termpop-follow-up-send");
    const historyNode = this.root.querySelector<HTMLDivElement>(".termpop-follow-up-history");
    const errorNode = this.root.querySelector<HTMLDivElement>(".termpop-follow-up-error");
    const composer = this.root.querySelector<HTMLDivElement>(".termpop-follow-up-composer");
    if (!input || !send || !historyNode || !errorNode || !composer) {
      return;
    }

    const history: FollowUpTurn[] = [];
    let initialExplanationVisible = false;
    let sending = false;
    const lockCardSize = () => {
      if (this.root.classList.contains("is-follow-up")) {
        return;
      }
      const height = Math.ceil(this.root.getBoundingClientRect().height);
      this.root.style.height = `${height}px`;
      this.root.classList.add("is-follow-up");
      this.pin();
      if (!initialExplanationVisible) {
        initialExplanationVisible = true;
        appendTurn("answer", explanation.definition);
      }
    };
    const updateSendState = () => {
      send.disabled = sending || !input.value.trim();
    };
    const appendTurn = (kind: "question" | "answer", text: string) => {
      const turn = document.createElement("div");
      turn.className = `termpop-follow-up-turn is-${kind}`;
      turn.textContent = text;
      historyNode.append(turn);
      historyNode.scrollTop = historyNode.scrollHeight;
    };
    const submit = async () => {
      const question = input.value.trim();
      if (!question || sending) {
        return;
      }
      lockCardSize();
      sending = true;
      errorNode.textContent = "";
      input.value = "";
      input.disabled = true;
      updateSendState();
      appendTurn("question", question);
      const pending = document.createElement("div");
      pending.className = "termpop-follow-up-turn is-answer is-pending";
      pending.textContent = copy[this.locale].answering;
      historyNode.append(pending);
      historyNode.scrollTop = historyNode.scrollHeight;
      try {
        const answer = await onFollowUp(question, history.slice());
        pending.remove();
        history.push({ question, answer });
        appendTurn("answer", answer);
      } catch (error) {
        pending.remove();
        errorNode.textContent = error instanceof Error ? error.message : copy[this.locale].followUpFailed;
      } finally {
        sending = false;
        input.disabled = false;
        updateSendState();
        input.focus();
      }
    };
    input.addEventListener("focus", lockCardSize);
    input.addEventListener("input", updateSendState);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    send.addEventListener("click", () => void submit());
  }

  private unlockFollowUpSize(): void {
    this.root.classList.remove("is-follow-up");
    this.root.style.removeProperty("height");
  }

  private resolvePlacement(canFitAbove: boolean, canFitBelow: boolean): "above" | "below" {
    if (this.initialPlacement === "below") {
      return canFitBelow || !canFitAbove ? "below" : "above";
    }

    return canFitAbove || !canFitBelow ? "above" : "below";
  }
}

function isRectInViewport(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function getBestAnchorRect(anchor: HTMLElement, point: Point | undefined): DOMRect {
  const rects = [...anchor.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) {
    return anchor.getBoundingClientRect();
  }

  if (!point) {
    return rects.find(isRectInViewport) ?? rects[0];
  }

  const containingRect = rects.find((rect) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  if (containingRect) {
    return containingRect;
  }

  const visibleRects = rects.filter(isRectInViewport);
  const candidates = visibleRects.length > 0 ? visibleRects : rects;
  return candidates
    .map((rect) => ({
      rect,
      distance: distanceToRect(point, rect)
    }))
    .sort((left, right) => left.distance - right.distance)[0].rect;
}

function distanceToRect(point: Point, rect: DOMRect): number {
  const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
  const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const copy = {
  zh: {
    loading: "正在生成解释...",
    refresh: "重新生成解释",
    delete: "删除",
    cancel: "取消",
    confirmDelete: "确认删除",
    followUpPlaceholder: "继续提问...",
    send: "发送",
    answering: "正在回答...",
    followUpFailed: "追问失败，请稍后再试。",
    deleteConfirmation: (term: string) => `“${term}” 不会再次自动高亮。如有需要，可在设置中恢复。`
  },
  en: {
    loading: "Generating explanation...",
    refresh: "Regenerate explanation",
    delete: "Remove",
    cancel: "Cancel",
    confirmDelete: "Remove",
    followUpPlaceholder: "Ask a follow-up...",
    send: "Send",
    answering: "Answering...",
    followUpFailed: "Follow-up failed. Please try again.",
    deleteConfirmation: (term: string) => `“${term}” will no longer be highlighted automatically. You can restore it in Settings.`
  }
} as const;

function uiLocale(): "zh" | "en" {
  const language = typeof chrome !== "undefined" && chrome.i18n?.getUILanguage
    ? chrome.i18n.getUILanguage()
    : navigator.language;
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
