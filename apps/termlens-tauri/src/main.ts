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
  related_terms?: string[];
};

type CaptureResponse = {
  text: string;
  terms: DetectedTerm[];
  highlights: Highlight[];
  explanation?: Explanation | null;
  sourceRect?: ScreenRect | null;
};

type LlmProvider = "mock" | "openai" | "kimi" | "openai-compatible" | "anthropic";
type ExplanationLanguage = "auto" | "zh-CN" | "en";

type LlmSettings = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  language: ExplanationLanguage;
  includeUsageExample: boolean;
  temperature: number;
  maxTokens: number;
};

type TestLogEntry = {
  id: string;
  time: string;
  level: "info" | "success" | "error";
  message: string;
  detail?: string;
};

const LLM_SETTINGS_KEY = "termlens.llmSettings";
const TEST_LOGS_KEY = "termlens.testLogs";
const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "mock",
  apiKey: "",
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.com/v1",
  language: "auto",
  includeUsageExample: false,
  temperature: 0.2,
  maxTokens: 450
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
  const llm = getLlmSettings();
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
      <section class="settings-section">
        <h2>LLM 配置</h2>
        <div class="form-grid">
          <label>
            <span>Provider</span>
            <select id="llmProvider">
              <option value="mock">Mock</option>
              <option value="openai">OpenAI</option>
              <option value="kimi">Kimi</option>
              <option value="openai-compatible">OpenAI Compatible / StepFun</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>输出语言</span>
            <select id="llmLanguage">
              <option value="auto">跟随上下文</option>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label class="wide">
            <span>Base URL</span>
            <input id="llmBaseUrl" type="url" spellcheck="false" />
          </label>
          <label>
            <span>Model</span>
            <input id="llmModel" type="text" spellcheck="false" />
          </label>
          <label>
            <span>API Key</span>
            <input id="llmApiKey" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <label>
            <span>Temperature</span>
            <input id="llmTemperature" type="number" min="0" max="2" step="0.1" />
          </label>
          <label>
            <span>Max tokens</span>
            <input id="llmMaxTokens" type="number" min="128" max="4096" step="32" />
          </label>
          <label class="toggle-row wide compact">
            <input id="llmIncludeExample" type="checkbox" />
            <span>生成例句</span>
          </label>
        </div>
        <div class="button-row">
          <button id="saveLlm" type="button">保存配置</button>
          <button id="testLlm" type="button">测试 LLM</button>
          <button id="clearLogs" type="button">清空日志</button>
        </div>
      </section>
      <section class="settings-section">
        <h2>测试日志</h2>
        <div id="testLogs" class="test-logs"></div>
      </section>
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

  fillLlmForm(root, llm);
  root.querySelector<HTMLSelectElement>("#llmProvider")?.addEventListener("change", (event) => {
    const provider = (event.currentTarget as HTMLSelectElement).value as LlmProvider;
    const next = providerDefaults(provider);
    const model = root.querySelector<HTMLInputElement>("#llmModel");
    const baseUrl = root.querySelector<HTMLInputElement>("#llmBaseUrl");
    if (model) model.value = next.model;
    if (baseUrl) baseUrl.value = next.baseUrl;
  });
  root.querySelector<HTMLButtonElement>("#saveLlm")?.addEventListener("click", () => {
    const next = readLlmForm(root);
    setLlmSettings(next);
    appendTestLog("success", "LLM 配置已保存", `${next.provider} · ${next.model} · ${next.baseUrl}`);
    renderTestLogs(root);
  });
  root.querySelector<HTMLButtonElement>("#testLlm")?.addEventListener("click", () => {
    void testLlmFromSettings(root);
  });
  root.querySelector<HTMLButtonElement>("#clearLogs")?.addEventListener("click", () => {
    localStorage.removeItem(TEST_LOGS_KEY);
    renderTestLogs(root);
  });

  window.addEventListener("storage", () => updateSettingsMetrics(root));
  window.setInterval(() => updateSettingsMetrics(root), 800);
  updateSettingsMetrics(root);
  renderTestLogs(root);
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
      void drawCapture(capture);
    } catch {
      clearOverlay();
    }
  };

  window.setInterval(() => void tick(), 900);
  void tick();
}

async function drawCapture(capture: CaptureResponse) {
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
  const explanation = await explanationForCapture(capture);
  if (!explanation || !firstRect) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  card.style.left = `${Math.min(window.innerWidth - 360, firstRect.right + 10)}px`;
  card.style.top = `${Math.max(12, firstRect.top)}px`;
  card.innerHTML = `
    <h2>${escapeHtml(explanation.term)}</h2>
    <p class="category">${escapeHtml(explanation.category)}</p>
    <p>${escapeHtml(explanation.definition)}</p>
    ${relatedTerms(explanation).length > 0
      ? `<div class="chips">${relatedTerms(explanation)
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

function fillLlmForm(root: HTMLElement, settings: LlmSettings) {
  setInputValue(root, "#llmProvider", settings.provider);
  setInputValue(root, "#llmLanguage", settings.language);
  setInputValue(root, "#llmBaseUrl", settings.baseUrl);
  setInputValue(root, "#llmModel", settings.model);
  setInputValue(root, "#llmApiKey", settings.apiKey);
  setInputValue(root, "#llmTemperature", String(settings.temperature));
  setInputValue(root, "#llmMaxTokens", String(settings.maxTokens));
  const include = root.querySelector<HTMLInputElement>("#llmIncludeExample");
  if (include) include.checked = settings.includeUsageExample;
}

function setInputValue(root: HTMLElement, selector: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (input) input.value = value;
}

function readLlmForm(root: HTMLElement): LlmSettings {
  const provider = (root.querySelector<HTMLSelectElement>("#llmProvider")?.value || "mock") as LlmProvider;
  const defaults = providerDefaults(provider);
  return {
    provider,
    apiKey: root.querySelector<HTMLInputElement>("#llmApiKey")?.value.trim() || "",
    model: root.querySelector<HTMLInputElement>("#llmModel")?.value.trim() || defaults.model,
    baseUrl: normalizeBaseUrl(root.querySelector<HTMLInputElement>("#llmBaseUrl")?.value.trim() || defaults.baseUrl),
    language: (root.querySelector<HTMLSelectElement>("#llmLanguage")?.value || "auto") as ExplanationLanguage,
    includeUsageExample: root.querySelector<HTMLInputElement>("#llmIncludeExample")?.checked ?? false,
    temperature: normalizeNumber(root.querySelector<HTMLInputElement>("#llmTemperature")?.value, 0.2),
    maxTokens: Math.max(128, Math.round(normalizeNumber(root.querySelector<HTMLInputElement>("#llmMaxTokens")?.value, 450)))
  };
}

function getLlmSettings(): LlmSettings {
  const raw = localStorage.getItem(LLM_SETTINGS_KEY);
  if (!raw) return DEFAULT_LLM_SETTINGS;
  try {
    return { ...DEFAULT_LLM_SETTINGS, ...(JSON.parse(raw) as Partial<LlmSettings>) };
  } catch {
    return DEFAULT_LLM_SETTINGS;
  }
}

function setLlmSettings(settings: LlmSettings) {
  localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings));
}

async function testLlmFromSettings(root: HTMLElement) {
  const settings = readLlmForm(root);
  setLlmSettings(settings);
  appendTestLog("info", "开始测试 LLM", `${settings.provider} · ${settings.model} · ${settings.baseUrl}`);
  renderTestLogs(root);
  try {
    const startedAt = performance.now();
    const text = await fetchLlmText(
      settings,
      "Return strict JSON only.",
      'Return {"ok":true,"message":"TermLens test passed"}'
    );
    const elapsed = Math.round(performance.now() - startedAt);
    appendTestLog("success", `LLM 测试成功，耗时 ${elapsed}ms`, text.slice(0, 800));
  } catch (error) {
    appendTestLog("error", "LLM 测试失败", error instanceof Error ? error.message : String(error));
  }
  renderTestLogs(root);
}

async function explanationForCapture(capture: CaptureResponse): Promise<Explanation | null> {
  const firstTerm = capture.terms[0]?.term;
  if (!firstTerm) return capture.explanation ?? null;
  const settings = getLlmSettings();
  if (settings.provider === "mock" || !settings.apiKey.trim()) {
    return normalizeExplanation(capture.explanation);
  }
  try {
    const explanation = await fetchLlmExplanation(firstTerm, capture.text, settings);
    appendTestLog("success", `释义生成成功：${firstTerm}`, `${settings.provider} · ${settings.model}`);
    return explanation;
  } catch (error) {
    appendTestLog("error", `释义生成失败：${firstTerm}`, error instanceof Error ? error.message : String(error));
    return normalizeExplanation(capture.explanation);
  }
}

async function fetchLlmExplanation(term: string, context: string, settings: LlmSettings): Promise<Explanation> {
  const content = await fetchLlmText(
    settings,
    [
      languageInstruction(settings.language),
      "You explain vocabulary in context.",
      settings.includeUsageExample
        ? "Return strict JSON only with keys: term, definition, category, relatedTerms, usageExample."
        : "Return strict JSON only with keys: term, definition, category, relatedTerms."
    ].join(" "),
    [
      `Term: ${term}`,
      `Context: ${context.slice(0, 1200)}`,
      "Definition should be 1-2 concise sentences and must fit the context."
    ].join("\n")
  );
  return parseExplanation(content, term, settings.includeUsageExample);
}

async function fetchLlmText(settings: LlmSettings, system: string, prompt: string): Promise<string> {
  return invoke<string>("fetch_llm_text", { settings, system, prompt });
}

async function fetchOpenAiCompatibleText(settings: LlmSettings, system: string, prompt: string): Promise<string> {
  const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(await formatProviderError(response));
  return extractOpenAiCompatibleText(await response.json());
}

async function fetchAnthropicText(settings: LlmSettings, system: string, prompt: string): Promise<string> {
  const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok) throw new Error(await formatProviderError(response));
  const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = payload.content?.find((part) => part.type === "text")?.text;
  if (!text) throw new Error(`LLM response did not include text content. Raw response: ${truncate(JSON.stringify(payload), 600)}`);
  return text;
}

function providerDefaults(provider: LlmProvider): Pick<LlmSettings, "baseUrl" | "model"> {
  if (provider === "kimi") return { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" };
  if (provider === "anthropic") return { baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-haiku-latest" };
  if (provider === "openai-compatible") return { baseUrl: "https://api.stepfun.com/v1", model: "step-2-mini" };
  if (provider === "mock") return { baseUrl: "https://api.openai.com/v1", model: "mock" };
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
}

function extractOpenAiCompatibleText(payload: unknown): string {
  const data = payload as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; text?: unknown }>;
  };
  const choice = data.choices?.[0];
  for (const candidate of [choice?.message?.content, choice?.message?.reasoning_content, choice?.message?.reasoning, choice?.text]) {
    const text = stringifyProviderText(candidate).trim();
    if (text) return text;
  }
  throw new Error(`LLM response did not include usable text. Raw response: ${truncate(JSON.stringify(payload), 600)}`);
}

function stringifyProviderText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseExplanation(content: string, fallbackTerm: string, includeUsageExample: boolean): Explanation {
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as Partial<Explanation>;
    return {
      term: String(parsed.term || fallbackTerm),
      definition: String(parsed.definition || ""),
      category: String(parsed.category || "术语"),
      relatedTerms: relatedTerms(parsed).slice(0, 5),
      usageExample: includeUsageExample && parsed.usageExample ? String(parsed.usageExample) : null
    };
  } catch {
    return {
      term: fallbackTerm,
      definition: truncate(content.replace(/\s+/g, " ").trim(), 700),
      category: "LLM explanation",
      relatedTerms: []
    };
  }
}

function normalizeExplanation(explanation: Explanation | null | undefined): Explanation | null {
  if (!explanation) return null;
  return {
    ...explanation,
    relatedTerms: relatedTerms(explanation)
  };
}

function relatedTerms(explanation: Partial<Explanation>): string[] {
  const values = explanation.relatedTerms ?? explanation.related_terms ?? [];
  return Array.isArray(values) ? values.map(String) : [];
}

function languageInstruction(language: ExplanationLanguage): string {
  if (language === "zh-CN") return "Output language: Simplified Chinese.";
  if (language === "en") return "Output language: English.";
  return "Output language: follow the surrounding context language.";
}

async function formatProviderError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message || json.message || `${response.status} ${response.statusText}`;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("LLM response was not valid JSON.");
}

function appendTestLog(level: TestLogEntry["level"], message: string, detail?: string) {
  const logs = readTestLogs();
  logs.unshift({
    id: crypto.randomUUID(),
    time: new Date().toLocaleString(),
    level,
    message,
    detail
  });
  localStorage.setItem(TEST_LOGS_KEY, JSON.stringify(logs.slice(0, 80)));
}

function readTestLogs(): TestLogEntry[] {
  const raw = localStorage.getItem(TEST_LOGS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TestLogEntry[];
  } catch {
    return [];
  }
}

function renderTestLogs(root: HTMLElement) {
  const target = root.querySelector<HTMLElement>("#testLogs");
  if (!target) return;
  const logs = readTestLogs();
  target.innerHTML = logs.length
    ? logs.map((log) => `
      <article class="log-entry ${log.level}">
        <div><b>${escapeHtml(log.message)}</b><time>${escapeHtml(log.time)}</time></div>
        ${log.detail ? `<pre>${escapeHtml(log.detail)}</pre>` : ""}
      </article>
    `).join("")
    : `<p class="empty-log">暂无测试日志</p>`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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
