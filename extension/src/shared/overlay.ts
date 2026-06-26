import type { Explanation } from "./types";

export interface OverlayOptions {
  rootId: string;
  anchorSelector: string;
}

export interface OverlayPointer {
  clientX: number;
  clientY: number;
}

interface Point {
  x: number;
  y: number;
}

export class TermLensOverlayController {
  private readonly root: HTMLDivElement;
  private readonly anchorSelector: string;
  private hideTimer: number | undefined;
  private repositionFrame: number | undefined;
  private currentAnchor: HTMLElement | undefined;
  private anchorPoint: Point | undefined;
  private initialPlacement: "above" | "below" | undefined;
  private pinned = false;
  private pointerOverCard = false;

  constructor(options: OverlayOptions) {
    this.anchorSelector = options.anchorSelector;
    this.root = document.createElement("div");
    this.root.id = options.rootId;
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
    this.render(anchor, `<div class="termlens-card-title">${escapeHtml(term)}</div><div class="termlens-muted">正在生成解释...</div>`, keepVisible, resetPlacement, pointer);
  }

  showError(anchor: HTMLElement, term: string, message: string, keepVisible = false, resetPlacement = false, pointer?: OverlayPointer): void {
    this.render(
      anchor,
      `<div class="termlens-card-title">${escapeHtml(term)}</div><div class="termlens-error">${escapeHtml(message)}</div>`,
      keepVisible,
      resetPlacement,
      pointer
    );
  }

  showExplanation(anchor: HTMLElement, explanation: Explanation, onRefresh: () => void, keepVisible = false, resetPlacement = false, pointer?: OverlayPointer): void {
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
       <div class="termlens-related">${related}</div>`,
      keepVisible,
      resetPlacement,
      pointer
    );
    this.root.querySelector<HTMLButtonElement>(".termlens-refresh-button")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.pin();
      onRefresh();
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
    this.pointerOverCard = false;
    this.currentAnchor = undefined;
    this.anchorPoint = undefined;
    this.initialPlacement = undefined;
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
    this.pinned = keepVisible;
    if (this.currentAnchor !== anchor || resetPlacement) {
      this.initialPlacement = undefined;
    }
    this.currentAnchor = anchor;
    if (pointer) {
      this.anchorPoint = { x: pointer.clientX, y: pointer.clientY };
    }
    this.cancelHide();
    this.root.innerHTML = `<div class="termlens-card">${html}</div>`;
    this.root.classList.add("is-visible");
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

    const anchorRect = getBestAnchorRect(anchor, this.anchorPoint);
    if (!isRectInViewport(anchorRect)) {
      this.root.classList.remove("is-visible");
      return;
    }

    this.root.classList.add("is-visible");
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
