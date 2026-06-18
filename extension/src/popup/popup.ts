import { getSettings, setLlmSettings, setMode } from "../shared/settings";
import type { ExplanationLanguage, LlmProvider, LlmSettings, TermLensMode } from "../shared/types";
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

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  setActive(settings.mode);
  renderLlmSettings(settings.llm);
  renderAppName(settings.llm.language);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode as TermLensMode;
      void saveMode(mode);
    });
  }

  providerInput?.addEventListener("change", () => {
    applyProviderDefaults(providerInput.value as LlmProvider);
  });

  languageInput?.addEventListener("change", () => {
    renderAppName((languageInput.value || "auto") as ExplanationLanguage);
  });

  llmForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLlm();
  });
}

async function saveMode(mode: TermLensMode): Promise<void> {
  await setMode(mode);
  setActive(mode);
  if (status) {
    status.textContent = "已保存。刷新页面后应用检测模式。";
  }
}

function setActive(mode: TermLensMode): void {
  for (const button of buttons) {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  }
}

async function saveLlm(): Promise<void> {
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

  await setLlmSettings(llm);
  renderAppName(llm.language);
  if (status) {
    status.textContent = llm.provider === "mock" ? "已保存。当前使用本地 Mock 解释。" : "已保存。当前使用 LLM 解释。";
  }
}

function renderAppName(language: ExplanationLanguage): void {
  const name = language === "en" ? "TermLens" : "词镜 TermLens";
  document.title = name;
  if (appTitle) {
    appTitle.textContent = name;
  }
}

function renderLlmSettings(llm: LlmSettings): void {
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

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}
