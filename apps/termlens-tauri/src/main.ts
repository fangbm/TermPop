import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type Highlight = {
  term: string;
  rect: ScreenRect;
};

type DetectedTerm = {
  term: string;
  termType: string;
  confidence: number;
  start: number;
  end: number;
};

type Explanation = {
  term: string;
  category: string;
  definition: string;
  usageExample?: string | null;
  relatedTerms: string[];
};

type CaptureResponse = {
  text: string;
  terms: DetectedTerm[];
  highlights: Highlight[];
  explanation?: Explanation | null;
  sourceRect?: ScreenRect | null;
};

const app = document.querySelector<HTMLDivElement>("#app");
const currentWindow = getCurrentWindow();

if (!app) {
  throw new Error("Missing #app root");
}

if (currentWindow.label === "overlay") {
  renderOverlay(app);
} else {
  renderSettings(app);
}

function renderSettings(root: HTMLDivElement) {
  const autoCaptureEnabled = localStorage.getItem("termlens.autoCapture") !== "false";
  const clickthroughEnabled = localStorage.getItem("termlens.clickthrough") !== "false";
  root.className = "settings-root";
  root.innerHTML = `
    <header class="settings-header">
      <div>
        <h1>词镜 TermLens</h1>
        <p>Tauri Windows 试验版</p>
      </div>
      <span class="status-dot"></span>
    </header>
    <main class="settings-main">
      <label class="toggle-row">
        <input id="autoCapture" type="checkbox" ${autoCaptureEnabled ? "checked" : ""} />
        <span>自动读屏并原位高亮</span>
      </label>
      <label class="toggle-row">
        <input id="clickthrough" type="checkbox" ${clickthroughEnabled ? "checked" : ""} />
        <span>高亮层鼠标穿透</span>
      </label>
      <div class="metric-grid">
        <div><b id="termCount">0</b><span>词条</span></div>
        <div><b id="highlightCount">0</b><span>原位矩形</span></div>
      </div>
      <p id="statusText" class="status-text">等待 overlay 捕获文本...</p>
    </main>
  `;

  const autoCapture = root.querySelector<HTMLInputElement>("#autoCapture");
  autoCapture?.addEventListener("change", () => {
    localStorage.setItem("termlens.autoCapture", String(autoCapture.checked));
  });

  const clickthrough = root.querySelector<HTMLInputElement>("#clickthrough");
  clickthrough?.addEventListener("change", () => {
    localStorage.setItem("termlens.clickthrough", String(clickthrough.checked));
    void invoke("set_overlay_clickthrough", { enabled: clickthrough.checked });
  });

  window.addEventListener("storage", () => updateSettingsMetrics(root));
  window.setInterval(() => updateSettingsMetrics(root), 800);
  updateSettingsMetrics(root);
}

function updateSettingsMetrics(root: HTMLDivElement) {
  const latest = readLatestCapture();
  root.querySelector("#termCount")!.textContent = String(latest?.terms.length ?? 0);
  root.querySelector("#highlightCount")!.textContent = String(latest?.highlights.length ?? 0);
  root.querySelector("#statusText")!.textContent = latest
    ? `最近捕获：${latest.terms[0]?.term ?? "未发现词条"}`
    : "等待 overlay 捕获文本...";
}

function renderOverlay(root: HTMLDivElement) {
  root.className = "overlay-root";
  root.innerHTML = `
    <div id="highlightLayer" class="highlight-layer"></div>
    <section id="explanationCard" class="explanation-card hidden"></section>
  `;

  const clickthroughEnabled = localStorage.getItem("termlens.clickthrough") !== "false";
  void invoke("set_overlay_clickthrough", { enabled: clickthroughEnabled });

  let lastKey = "";
  const tick = async () => {
    if (localStorage.getItem("termlens.autoCapture") === "false") {
      clearOverlay();
      return;
    }
    try {
      const capture = await invoke<CaptureResponse>("capture_terms");
      const key = makeCaptureKey(capture);
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      localStorage.setItem("termlens.latestCapture", JSON.stringify(capture));
      drawCapture(capture);
    } catch {
      clearOverlay();
    }
  };

  window.setInterval(() => void tick(), 900);
  void tick();
}

function drawCapture(capture: CaptureResponse) {
  const layer = document.querySelector<HTMLDivElement>("#highlightLayer");
  const card = document.querySelector<HTMLElement>("#explanationCard");
  if (!layer || !card) {
    return;
  }

  layer.innerHTML = "";
  for (const highlight of capture.highlights) {
    const mark = document.createElement("div");
    mark.className = "source-highlight";
    mark.style.left = `${highlight.rect.left}px`;
    mark.style.top = `${highlight.rect.top}px`;
    mark.style.width = `${Math.max(4, highlight.rect.right - highlight.rect.left)}px`;
    mark.style.height = `${Math.max(4, highlight.rect.bottom - highlight.rect.top)}px`;
    mark.dataset.term = highlight.term;
    layer.appendChild(mark);
  }

  const firstRect = capture.highlights[0]?.rect ?? capture.sourceRect;
  if (!capture.explanation || !firstRect) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  card.style.left = `${Math.min(window.innerWidth - 360, firstRect.right + 10)}px`;
  card.style.top = `${Math.max(12, firstRect.top)}px`;
  card.innerHTML = `
    <h2>${escapeHtml(capture.explanation.term)}</h2>
    <p class="category">${escapeHtml(capture.explanation.category)}</p>
    <p>${escapeHtml(capture.explanation.definition)}</p>
    ${capture.explanation.relatedTerms.length > 0
      ? `<div class="chips">${capture.explanation.relatedTerms
          .map((term) => `<span>${escapeHtml(term)}</span>`)
          .join("")}</div>`
      : ""}
  `;
}

function clearOverlay() {
  document.querySelector<HTMLDivElement>("#highlightLayer")!.innerHTML = "";
  document.querySelector<HTMLElement>("#explanationCard")!.classList.add("hidden");
}

function makeCaptureKey(capture: CaptureResponse) {
  return [
    capture.text.slice(0, 160),
    capture.terms.map((term) => term.term).join("|"),
    capture.highlights
      .map((highlight) =>
        [highlight.term, highlight.rect.left, highlight.rect.top, highlight.rect.right, highlight.rect.bottom].join(",")
      )
      .join("|")
  ].join("::");
}

function readLatestCapture(): CaptureResponse | null {
  const raw = localStorage.getItem("termlens.latestCapture");
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as CaptureResponse;
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
