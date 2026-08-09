import type { CaptureVisibleTabRequest, CaptureVisibleTabResponse } from "../shared/types";

const CONSENT_STORAGE_KEY = "termpop.screenshotRecognitionConsent.v1";
const ROOT_ID = "termpop-screenshot-root";

export interface ScreenshotSelectionResult {
  rect: ScreenshotRect;
  termImageDataUrl: string;
  contextImageDataUrl: string;
  pointer: { clientX: number; clientY: number };
}

interface ScreenshotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Locale = "zh" | "en";

export class ScreenshotSelectionController {
  private readonly locale: Locale;
  private cancelActive: (() => void) | undefined;

  constructor(locale: Locale) {
    this.locale = locale;
  }

  async begin(): Promise<ScreenshotSelectionResult | undefined> {
    this.cancel();
    if (!await this.ensureConsent()) {
      return undefined;
    }
    const rect = await this.selectArea();
    if (!rect) {
      return undefined;
    }
    await afterNextPaint();
    const response = await chrome.runtime.sendMessage({
      type: "TERMPOP_CAPTURE_VISIBLE_TAB"
    } satisfies CaptureVisibleTabRequest) as CaptureVisibleTabResponse;
    if (!response.ok || !response.dataUrl) {
      throw new Error(response.error || copy[this.locale].captureFailed);
    }
    const image = await loadImage(response.dataUrl);
    const termRect = expandRect(rect, 12, 8);
    const contextRect = expandRect(rect, 180, 120);
    return {
      rect,
      termImageDataUrl: cropImage(image, termRect, "image/png", 1200),
      contextImageDataUrl: cropImage(image, contextRect, "image/jpeg", 1600),
      pointer: {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }
    };
  }

  cancel(): void {
    this.cancelActive?.();
    this.cancelActive = undefined;
    document.getElementById(ROOT_ID)?.remove();
  }

  private async ensureConsent(): Promise<boolean> {
    const stored = await chrome.storage.local.get(CONSENT_STORAGE_KEY);
    if (stored[CONSENT_STORAGE_KEY] === true) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const root = createRoot();
      const panel = document.createElement("div");
      panel.className = "termpop-screenshot-consent";
      panel.innerHTML = `
        <h2>${escapeHtml(copy[this.locale].consentTitle)}</h2>
        <p>${escapeHtml(copy[this.locale].consentBody)}</p>
        <div class="termpop-screenshot-consent-actions">
          <button type="button" data-action="cancel">${escapeHtml(copy[this.locale].cancel)}</button>
          <button type="button" data-action="continue" data-primary="true">${escapeHtml(copy[this.locale].continue)}</button>
        </div>`;
      root.append(panel);
      document.documentElement.append(root);
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        root.remove();
        document.removeEventListener("keydown", onKeyDown, true);
        this.cancelActive = undefined;
        resolve(value);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      };
      panel.querySelector<HTMLButtonElement>("[data-action='cancel']")?.addEventListener("click", () => finish(false));
      panel.querySelector<HTMLButtonElement>("[data-action='continue']")?.addEventListener("click", () => {
        void chrome.storage.local.set({ [CONSENT_STORAGE_KEY]: true }).then(() => finish(true));
      });
      document.addEventListener("keydown", onKeyDown, true);
      this.cancelActive = () => finish(false);
    });
  }

  private selectArea(): Promise<ScreenshotRect | undefined> {
    return new Promise((resolve) => {
      const root = createRoot();
      root.classList.add("is-selecting");
      const hint = document.createElement("div");
      hint.className = "termpop-screenshot-hint";
      hint.textContent = copy[this.locale].hint;
      const selection = document.createElement("div");
      selection.className = "termpop-screenshot-selection";
      root.append(hint, selection);
      document.documentElement.append(root);
      let settled = false;
      let start: { x: number; y: number } | undefined;

      const finish = (rect?: ScreenshotRect) => {
        if (settled) {
          return;
        }
        settled = true;
        root.remove();
        document.removeEventListener("keydown", onKeyDown, true);
        this.cancelActive = undefined;
        resolve(rect);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish();
        }
      };
      root.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        start = { x: clamp(event.clientX, 0, window.innerWidth), y: clamp(event.clientY, 0, window.innerHeight) };
        selection.style.display = "block";
        positionSelection(selection, rectFromPoints(start, start));
        root.setPointerCapture(event.pointerId);
      });
      root.addEventListener("pointermove", (event) => {
        if (!start) {
          return;
        }
        event.preventDefault();
        const current = { x: clamp(event.clientX, 0, window.innerWidth), y: clamp(event.clientY, 0, window.innerHeight) };
        positionSelection(selection, rectFromPoints(start, current));
      });
      root.addEventListener("pointerup", (event) => {
        if (!start || event.button !== 0) {
          return;
        }
        event.preventDefault();
        const current = { x: clamp(event.clientX, 0, window.innerWidth), y: clamp(event.clientY, 0, window.innerHeight) };
        const rect = rectFromPoints(start, current);
        start = undefined;
        if (rect.width < 8 || rect.height < 8) {
          selection.style.display = "none";
          return;
        }
        finish(rect);
      });
      root.addEventListener("contextmenu", (event) => event.preventDefault());
      document.addEventListener("keydown", onKeyDown, true);
      this.cancelActive = () => finish();
    });
  }
}

function createRoot(): HTMLDivElement {
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.dataset.termpopIgnore = "true";
  return root;
}

function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): ScreenshotRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function positionSelection(element: HTMLElement, rect: ScreenshotRect): void {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function expandRect(rect: ScreenshotRect, horizontal: number, vertical: number): ScreenshotRect {
  const left = clamp(rect.left - horizontal, 0, window.innerWidth);
  const top = clamp(rect.top - vertical, 0, window.innerHeight);
  const right = clamp(rect.left + rect.width + horizontal, 0, window.innerWidth);
  const bottom = clamp(rect.top + rect.height + vertical, 0, window.innerHeight);
  return { left, top, width: right - left, height: bottom - top };
}

function cropImage(image: HTMLImageElement, rect: ScreenshotRect, format: "image/png" | "image/jpeg", maxDimension: number): string {
  const scaleX = image.naturalWidth / Math.max(window.innerWidth, 1);
  const scaleY = image.naturalHeight / Math.max(window.innerHeight, 1);
  const sourceX = Math.max(0, Math.round(rect.left * scaleX));
  const sourceY = Math.max(0, Math.round(rect.top * scaleY));
  const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, Math.round(rect.width * scaleX)));
  const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, Math.round(rect.height * scaleY)));
  const outputScale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * outputScale));
  canvas.height = Math.max(1, Math.round(sourceHeight * outputScale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The browser could not prepare the selected screenshot.");
  }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(format, format === "image/jpeg" ? 0.88 : undefined);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The captured screenshot could not be decoded."));
    image.src = dataUrl;
  });
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const copy = {
  zh: {
    consentTitle: "启用截图识词",
    consentBody: "TermPop 会按设置使用本地 OCR，或把你框选的区域和少量周边画面发送到当前配置的多模态 LLM。截图本身不会写入 TermPop 缓存。",
    cancel: "取消",
    continue: "继续框选",
    hint: "拖动框选要解释的词汇，按 Esc 取消",
    captureFailed: "无法截取当前页面。"
  },
  en: {
    consentTitle: "Enable screenshot recognition",
    consentBody: "Depending on your settings, TermPop uses local OCR or sends the selected area and a small surrounding region to your configured multimodal LLM. Screenshot images are not stored in the TermPop cache.",
    cancel: "Cancel",
    continue: "Continue",
    hint: "Drag around the term to explain. Press Esc to cancel.",
    captureFailed: "The current page could not be captured."
  }
} as const;
