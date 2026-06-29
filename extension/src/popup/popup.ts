import { getSettings, setLlmSettings, setMode } from "../shared/settings";
import type { ExplanationLanguage, LlmProvider, LlmSettings, TermPopMode } from "../shared/types";
import "./popup.css";

const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mode]"));
const appTitle = document.querySelector<HTMLHeadingElement>("#app-title");
const status = document.querySelector<HTMLParagraphElement>("#status");
const llmForm = document.querySelector<HTMLFormElement>("#llm-form");
const providerInput = document.querySelector<HTMLSelectElement>("#provider");
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key");
const modelInput = document.querySelector<HTMLInputElement>("#model");
const baseUrlInput = document.querySelector<HTMLInputElement>("#base-url");
const languageInput = document.querySelector<HTMLSelectElement>("#language");
const includeUsageExampleInput = document.querySelector<HTMLInputElement>("#include-usage-example");
const temperatureInput = document.querySelector<HTMLInputElement>("#temperature");
const maxTokensInput = document.querySelector<HTMLInputElement>("#max-tokens");
const maxConcurrencyInput = document.querySelector<HTMLInputElement>("#max-concurrency");
const pdfTools = document.querySelector<HTMLElement>(".pdf-tools");
const openPdfViewerButton = document.querySelector<HTMLButtonElement>("#open-pdf-viewer");
const AUTO_SAVE_DELAY_MS = 400;
let autoSaveTimer: number | undefined;

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  setActive(settings.mode);
  renderLlmSettings(settings.llm);
  renderAppName(settings.llm.language);
  renderModeLabels(settings.llm.language);
  await renderPdfToolsVisibility();

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode as TermPopMode;
      void saveMode(mode);
    });
  }

  providerInput?.addEventListener("change", () => {
    applyProviderDefaults(providerInput.value as LlmProvider);
    void saveLlm();
  });

  languageInput?.addEventListener("change", () => {
    const language = (languageInput.value || "auto") as ExplanationLanguage;
    renderAppName(language);
    renderModeLabels(language);
    void saveLlm();
  });

  llmForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLlm();
  });

  for (const input of [apiKeyInput, modelInput, baseUrlInput, temperatureInput, maxTokensInput, maxConcurrencyInput]) {
    input?.addEventListener("input", scheduleLlmAutoSave);
    input?.addEventListener("change", scheduleLlmAutoSave);
  }

  includeUsageExampleInput?.addEventListener("change", () => {
    void saveLlm();
  });

  openPdfViewerButton?.addEventListener("click", () => {
    void openPdfViewerForActiveTab();
  });
}

async function saveMode(mode: TermPopMode): Promise<void> {
  await setMode(mode);
  setActive(mode);
  if (status) {
    status.textContent = "已保存。当前页面会自动切换展示方式。";
  }
}

function setActive(mode: TermPopMode): void {
  for (const button of buttons) {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  }
}

async function openPdfViewerForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceUrl = tab?.url;
  if (!sourceUrl) {
    if (status) status.textContent = "没有找到当前标签页。";
    return;
  }

  const pdfUrl = extractPdfUrl(sourceUrl);
  if (!pdfUrl) {
    if (status) status.textContent = "当前页面不是可识别的 PDF。";
    return;
  }

  const viewerUrl = chrome.runtime.getURL(`assets/pdf-viewer.html?src=${encodeURIComponent(pdfUrl)}`);
  await chrome.tabs.create({ url: viewerUrl, active: true });
  window.close();
}

async function renderPdfToolsVisibility(): Promise<void> {
  if (!pdfTools) {
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pdfTools.hidden = !extractPdfUrl(tab?.url ?? "");
}

async function saveLlm(): Promise<void> {
  if (autoSaveTimer !== undefined) {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = undefined;
  }

  const llm = collectLlmSettings();
  renderNormalizedLlmFields(llm);
  await setLlmSettings(llm);
  renderAppName(llm.language);
  renderModeLabels(llm.language);
  if (status) {
    status.textContent = llm.provider === "mock" ? "已自动保存。当前使用本地 Mock 解释。" : "已自动保存。当前使用 LLM 解释。";
  }
}

function scheduleLlmAutoSave(): void {
  if (autoSaveTimer !== undefined) {
    window.clearTimeout(autoSaveTimer);
  }
  if (status) {
    status.textContent = "正在自动保存...";
  }
  autoSaveTimer = window.setTimeout(() => {
    void saveLlm();
  }, AUTO_SAVE_DELAY_MS);
}

function collectLlmSettings(): LlmSettings {
  const llm: LlmSettings = {
    provider: (providerInput?.value || "mock") as LlmProvider,
    apiKey: apiKeyInput?.value.trim() || "",
    model: modelInput?.value.trim() || defaultModel((providerInput?.value || "mock") as LlmProvider),
    baseUrl: normalizeBaseUrl(baseUrlInput?.value.trim() || defaultBaseUrl((providerInput?.value || "mock") as LlmProvider)),
    language: (languageInput?.value || "auto") as ExplanationLanguage,
    includeUsageExample: includeUsageExampleInput?.checked ?? false,
    maxConcurrency: Math.round(clampNumber(Number(maxConcurrencyInput?.value), 1, Number.MAX_SAFE_INTEGER, 5)),
    temperature: clampNumber(Number(temperatureInput?.value), 0, 2, 0.2),
    maxTokens: Math.round(clampNumber(Number(maxTokensInput?.value), 128, 4000, 450))
  };
  return llm;
}

function renderAppName(language: ExplanationLanguage): void {
  const name = language === "en" ? "TermPop" : "TermPop";
  document.title = name;
  if (appTitle) {
    appTitle.textContent = name;
  }
}

function renderModeLabels(language: ExplanationLanguage): void {
  for (const button of buttons) {
    button.textContent = language === "en" ? button.dataset.labelEn ?? "" : button.dataset.labelZh ?? "";
  }
}

function renderLlmSettings(llm: LlmSettings): void {
  renderNormalizedLlmFields(llm);
}

function renderNormalizedLlmFields(llm: LlmSettings): void {
  if (providerInput) providerInput.value = llm.provider;
  if (apiKeyInput) apiKeyInput.value = llm.apiKey;
  if (modelInput) modelInput.value = llm.model;
  if (baseUrlInput) baseUrlInput.value = llm.baseUrl;
  if (languageInput) languageInput.value = llm.language;
  if (includeUsageExampleInput) includeUsageExampleInput.checked = llm.includeUsageExample;
  if (maxConcurrencyInput) maxConcurrencyInput.value = String(llm.maxConcurrency);
  if (temperatureInput) temperatureInput.value = String(llm.temperature);
  if (maxTokensInput) maxTokensInput.value = String(llm.maxTokens);
}

function applyProviderDefaults(provider: LlmProvider): void {
  if (modelInput) {
    modelInput.value = defaultModel(provider);
  }
  if (baseUrlInput) {
    baseUrlInput.value = defaultBaseUrl(provider);
  }
}

function defaultBaseUrl(provider: LlmProvider): string {
  if (provider === "kimi") {
    return "https://api.moonshot.cn/v1";
  }
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function defaultModel(provider: LlmProvider): string {
  if (provider === "kimi") {
    return "moonshot-v1-8k";
  }
  if (provider === "anthropic") {
    return "claude-3-5-haiku-latest";
  }
  if (provider === "mock") {
    return "mock";
  }
  return "gpt-4.1-mini";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractPdfUrl(value: string): string | undefined {
  if (/^chrome-extension:/i.test(value)) {
    const src = new URL(value).searchParams.get("src");
    return src && isPdfUrl(src) ? src : undefined;
  }
  return isPdfUrl(value) ? value : undefined;
}

function isPdfUrl(value: string): boolean {
  return /^(https?|file):/i.test(value) && /\.pdf(?:[?#].*)?$/i.test(decodeURIComponent(value));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}
