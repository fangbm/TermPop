import { getSettings, setLlmSettings, setMode, setPrivacySettings } from "../shared/settings";
import { defaultBaseUrl, normalizeBaseUrl } from "../shared/llm-defaults";
import { ALL_SITES_ORIGIN_PATTERNS, FILE_ORIGIN_PATTERN, providerOriginPatternFromBaseUrl } from "../shared/browser-utils";
import { termpopWebsiteUrl } from "../shared/website";
import { clearIgnoredTerms, IGNORED_TERMS_STORAGE_KEY, parseIgnoredTerms, removeIgnoredTerm } from "../shared/ignored-terms";
import { promptInstruction } from "../background/prompts";
import type {
  ExplanationLanguage,
  GetSiteAccessResponse,
  InjectActiveTabResponse,
  LlmProvider,
  LlmSettings,
  PromptOverrides,
  PromptTemplateKind,
  ScreenshotRecognitionMode,
  SetSiteAccessResponse,
  SiteAccessState,
  TermPopMode,
  DisableSiteRequest,
  DisableSiteResponse,
  ExplainSelectionTermsRequest,
  PrivacySettings,
  SummarizeVisibleRequest,
  TestLlmProviderResponse
} from "../shared/types";
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
const screenshotRecognitionEnabledInput = document.querySelector<HTMLInputElement>("#screenshot-recognition-enabled");
const screenshotRecognitionModeInput = document.querySelector<HTMLSelectElement>("#screenshot-recognition-mode");
const screenshotShortcut = document.querySelector<HTMLElement>("#screenshot-shortcut");
const customizeShortcutButton = document.querySelector<HTMLButtonElement>("#customize-shortcut");
const openGuideButton = document.querySelector<HTMLButtonElement>("#open-guide");
const openDocsButton = document.querySelector<HTMLButtonElement>("#open-docs");
const temperatureInput = document.querySelector<HTMLInputElement>("#temperature");
const maxTokensInput = document.querySelector<HTMLInputElement>("#max-tokens");
const maxConcurrencyInput = document.querySelector<HTMLInputElement>("#max-concurrency");
const providerTestButton = document.querySelector<HTMLButtonElement>("#provider-test");
const advancedToggle = document.querySelector<HTMLButtonElement>("#advanced-toggle");
const advancedSettings = document.querySelector<HTMLElement>("#advanced-settings");
const promptTemplateInput = document.querySelector<HTMLSelectElement>("#prompt-template");
const promptTemplateEditor = document.querySelector<HTMLTextAreaElement>("#prompt-template-editor");
const resetPromptTemplateButton = document.querySelector<HTMLButtonElement>("#reset-prompt-template");
const siteAccess = document.querySelector<HTMLElement>(".site-access");
const siteAccessStatus = document.querySelector<HTMLParagraphElement>("#site-access-status");
const siteAccessToggle = document.querySelector<HTMLButtonElement>("#site-access-toggle");
const pdfTools = document.querySelector<HTMLElement>(".pdf-tools");
const openPdfViewerButton = document.querySelector<HTMLButtonElement>("#open-pdf-viewer");
const ignoredTermsList = document.querySelector<HTMLElement>("#ignored-terms-list");
const restoreAllIgnoredTermsButton = document.querySelector<HTMLButtonElement>("#restore-all-ignored-terms");
const summarizeVisibleButton = document.querySelector<HTMLButtonElement>("#summarize-visible");
const batchExplainSelectionButton = document.querySelector<HTMLButtonElement>("#batch-explain-selection");
const exportMarkdownButton = document.querySelector<HTMLButtonElement>("#export-markdown");
const exportCsvButton = document.querySelector<HTMLButtonElement>("#export-csv");
const privacyLocalOnlyInput = document.querySelector<HTMLInputElement>("#privacy-local-only");
const privacyPreviewBeforeSendInput = document.querySelector<HTMLInputElement>("#privacy-preview-before-send");
const privacyDisableScreenshotUploadInput = document.querySelector<HTMLInputElement>("#privacy-disable-screenshot-upload");
const privacyOnlyExplainSelectionInput = document.querySelector<HTMLInputElement>("#privacy-only-explain-selection");
const AUTO_SAVE_DELAY_MS = 400;
let autoSaveTimer: number | undefined;
let settingsWriteChain: Promise<void> = Promise.resolve();
let latestLlmSaveId = 0;
const composingInputs = new Set<HTMLInputElement>();
let currentSiteAccess: SiteAccessState | undefined;
let currentPromptTemplate: PromptTemplateKind = "detection";
let promptOverrides: PromptOverrides = {};
type UiLocale = "zh" | "en";

const uiLocale: UiLocale = chrome.i18n.getUILanguage().toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
const t = {
  zh: {
    subtitle: "AI 词汇解释助手",
    autoSaveHint: "自动保存",
    readingMode: "阅读方式",
    readingModeNote: "选择你更习惯的解释触发方式。",
    modeGroupLabel: "检测模式",
    currentSite: "网站访问",
    readingPermission: "正在读取权限...",
    enableAllSites: "在所有网站启用 TermPop",
    blockCurrentSite: "在当前站点停用",
    unblockCurrentSite: "在当前站点重新启用",
    enableLocalFiles: "启用本地文件访问",
    disableLocalFiles: "停用本地文件访问",
    unavailable: "不可用",
    unsupportedPage: "当前页面不支持注入。",
    allSitesRequired: "首次使用需确认一次全站权限，之后无需逐站启用。",
    enabledOnSite: "TermPop 已在所有网站启用，当前站点允许运行。",
    blockedOnSite: "当前站点已加入黑名单，TermPop 不会读取或高亮页面内容。",
    localFilesEnabled: "TermPop 已获准访问本地文件。",
    localFilesDisabled: "本地文件需要单独授权，不会随全站权限自动开启。",
    permissionDenied: "未获得所需的网站访问权限。",
    saveSiteAccessFailed: "保存站点权限失败。",
    enabledAndInjected: "全站权限已启用，并已注入当前页面。",
    enabledRefreshRequired: "已启用，刷新页面后生效。",
    disabledAndCleaned: "当前站点已加入黑名单，并清理了页面高亮。",
    unblockedAndInjected: "已从黑名单移除并重新启用当前站点。",
    savedMode: "已保存。当前页面会自动切换展示方式。",
    noCurrentTab: "没有找到当前标签页。",
    notPdf: "当前页面不是可识别的 PDF。",
    pdfButton: "用 TermPop 打开当前 PDF",
    pdfToolsNote: "适用于网页 PDF 或本地 PDF 文件。浏览器可能需要为插件开启“允许访问文件网址”。",
    provider: "服务商",
    llmConnection: "LLM 连接",
    llmConnectionNote: "配置后用于抽词、释义与追问。",
    localOnly: "本地配置",
    model: "模型",
    explanationPreferences: "解释偏好",
    explanationLanguage: "解释语言",
    languageAuto: "跟随上下文",
    languageChinese: "中文",
    includeUsageExample: "生成例句",
    screenshotRecognitionEnabled: "启用截图解释",
    screenshotNote: "用快捷键截取区域，识别后直接解释。",
    screenshotRecognitionMode: "截图识别方式",
    screenshotModeAuto: "自动选择",
    screenshotModeMultimodal: "多模态 LLM",
    screenshotModeOcr: "本地 OCR",
    screenshotShortcutLabel: "截图快捷键",
    customizeShortcut: "自定义快捷键",
    resourcesLabel: "指南与文档",
    resourcesNote: "首次使用或遇到问题时，可打开官网新手向导和文档。",
    openGuide: "打开新手向导",
    openDocs: "打开文档",
    shortcutUnassigned: "未设置",
    advancedSettings: "高级设置",
    collapseAdvancedSettings: "收起高级设置",
    temperature: "温度",
    maxConcurrency: "并发限制",
    promptEditor: "提示词编辑",
    promptEditorDetection: "LLM 摘词",
    promptEditorExplanation: "词条释义",
    promptEditorScreenshot: "截图识别",
    promptEditorFollowUp: "追问回答",
    resetPrompt: "恢复默认",
    saving: "正在自动保存...",
    savedLlm: "已自动保存。当前使用 LLM 解释。",
    savedUnconfigured: "已自动保存。LLM 未配置，释义与 LLM 摘词不可用。",
    testProvider: "测试连接",
    testingProvider: "正在测试连接...",
    providerTestSucceeded: "连接测试成功。",
    providerNeedsAllSites: "请先点击“在所有网站启用 TermPop”，再测试服务商连接。",
    providerApiKeyRequired: "LLM 未配置，请先填写 API Key。",
    providerBaseUrlInvalid: "Base URL 必须是 HTTP 或 HTTPS 地址。",
    providerTestFailed: "服务商测试失败",
    ignoredTerms: "已忽略词",
    ignoredTermsNote: "这些词不会再自动高亮。划词和截图解释不受影响。",
    ignoredTermsEmpty: "暂无已忽略词。",
    restoreTerm: "恢复",
    restoreAll: "全部恢复",
    readingTools: "阅读工具",
    readingToolsNote: "主动整理当前可见内容，或批量解释已经选中的一段文字。",
    summarizeVisible: "摘要当前可见内容",
    batchExplainSelection: "批量解释选区",
    readingAssistSent: "已在当前页面打开阅读辅助面板。",
    readingAssistFailed: "无法在当前页面启动阅读辅助。",
    exportData: "导出本地数据",
    exportDataNote: "导出用户词库和已忽略词，便于备份或迁移。",
    exportMarkdown: "导出 Markdown",
    exportCsv: "导出 CSV",
    exportSucceeded: "本地数据已开始下载。",
    privacyControls: "隐私控制",
    privacyControlsNote: "这些开关只影响此浏览器内的 TermPop。",
    localOnlyDictionary: "仅使用本地词库进行自动高亮",
    previewBeforeSend: "发送页面摘要和批量解释前预览文本",
    disableScreenshotUpload: "不上传截图，始终使用本地 OCR",
    onlyExplainSelection: "仅解释主动选中的文本",
    modes: {
      hover: "悬停",
      selection: "划词",
      hybrid: "混合"
    }
  },
  en: {
    subtitle: "AI term explanation assistant",
    autoSaveHint: "Auto-save",
    readingMode: "Reading mode",
    readingModeNote: "Choose how you want explanations to appear.",
    modeGroupLabel: "Detection mode",
    currentSite: "Website access",
    readingPermission: "Reading permissions...",
    enableAllSites: "Enable TermPop on all websites",
    blockCurrentSite: "Disable on this site",
    unblockCurrentSite: "Re-enable on this site",
    enableLocalFiles: "Enable local file access",
    disableLocalFiles: "Disable local file access",
    unavailable: "Unavailable",
    unsupportedPage: "This page does not support injection.",
    allSitesRequired: "Grant website access once to use TermPop without enabling every site separately.",
    enabledOnSite: "TermPop is enabled on all websites and allowed on this site.",
    blockedOnSite: "This site is blocked. TermPop will not read or highlight its content.",
    localFilesEnabled: "TermPop can access local files.",
    localFilesDisabled: "Local files require separate permission and are not included in website access.",
    permissionDenied: "The required website permission was not granted.",
    saveSiteAccessFailed: "Failed to save site permission.",
    enabledAndInjected: "Website access enabled and injected into the current page.",
    enabledRefreshRequired: "Enabled. Refresh the page if highlights do not appear.",
    disabledAndCleaned: "Added this site to the blocklist and removed current highlights.",
    unblockedAndInjected: "Removed this site from the blocklist and re-enabled it.",
    savedMode: "Saved. The current page will switch display mode automatically.",
    noCurrentTab: "No active tab was found.",
    notPdf: "The current page is not a recognizable PDF.",
    pdfButton: "Open current PDF with TermPop",
    pdfToolsNote: "Works with web PDFs or local PDF files. Your browser may need file URL access enabled for this extension.",
    provider: "Provider",
    llmConnection: "LLM connection",
    llmConnectionNote: "Used for term detection, explanations, and follow-ups.",
    localOnly: "Local setup",
    model: "Model",
    explanationPreferences: "Explanation preferences",
    explanationLanguage: "Explanation language",
    languageAuto: "Follow context",
    languageChinese: "Chinese",
    includeUsageExample: "Generate usage example",
    screenshotRecognitionEnabled: "Enable screenshot explanations",
    screenshotNote: "Capture an area with a shortcut and explain it in place.",
    screenshotRecognitionMode: "Screenshot recognition",
    screenshotModeAuto: "Automatic",
    screenshotModeMultimodal: "Multimodal LLM",
    screenshotModeOcr: "Local OCR",
    screenshotShortcutLabel: "Screenshot shortcut",
    customizeShortcut: "Customize shortcut",
    resourcesLabel: "Guides and docs",
    resourcesNote: "Open the website guide or documentation for first-time setup and troubleshooting.",
    openGuide: "Open guide",
    openDocs: "Open docs",
    shortcutUnassigned: "Not assigned",
    advancedSettings: "Advanced settings",
    collapseAdvancedSettings: "Collapse advanced settings",
    temperature: "Temperature",
    maxConcurrency: "Concurrency limit",
    promptEditor: "Prompt editor",
    promptEditorDetection: "LLM detection",
    promptEditorExplanation: "Term explanation",
    promptEditorScreenshot: "Screenshot recognition",
    promptEditorFollowUp: "Follow-up answers",
    resetPrompt: "Reset default",
    saving: "Saving automatically...",
    savedLlm: "Saved automatically. LLM explanations are active.",
    savedUnconfigured: "Saved automatically. LLM is not configured, so explanations and LLM detection are unavailable.",
    testProvider: "Test connection",
    testingProvider: "Testing connection...",
    providerTestSucceeded: "Connection test succeeded.",
    providerNeedsAllSites: "Enable TermPop on all websites before testing the provider connection.",
    providerApiKeyRequired: "LLM is not configured. Enter an API key first.",
    providerBaseUrlInvalid: "Base URL must use an HTTP or HTTPS origin.",
    providerTestFailed: "Provider test failed",
    ignoredTerms: "Ignored terms",
    ignoredTermsNote: "These terms are not highlighted automatically. Selection and screenshot explanations are unchanged.",
    ignoredTermsEmpty: "No ignored terms.",
    restoreTerm: "Restore",
    restoreAll: "Restore all",
    readingTools: "Reading tools",
    readingToolsNote: "Summarize visible content or explain important terms in selected text.",
    summarizeVisible: "Summarize visible content",
    batchExplainSelection: "Explain selected terms",
    readingAssistSent: "Opened the reading assistant on the current page.",
    readingAssistFailed: "The reading assistant could not start on this page.",
    exportData: "Export local data",
    exportDataNote: "Export your user dictionary and ignored terms for backup or migration.",
    exportMarkdown: "Export Markdown",
    exportCsv: "Export CSV",
    exportSucceeded: "Your local data download has started.",
    privacyControls: "Privacy controls",
    privacyControlsNote: "These controls affect TermPop in this browser only.",
    localOnlyDictionary: "Use only the local dictionary for automatic highlighting",
    previewBeforeSend: "Preview text before summary and batch requests",
    disableScreenshotUpload: "Never upload screenshots; always use local OCR",
    onlyExplainSelection: "Explain only text I actively select",
    modes: {
      hover: "Hover",
      selection: "Selection",
      hybrid: "Hybrid"
    }
  }
} as const;

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  applyUiLocale();
  setActive(settings.mode);
  renderLlmSettings(settings.llm);
  renderPrivacySettings(settings.privacy);
  renderAppName();
  renderModeLabels();
  renderAdvancedSettings(settings.llm);
  // Bind controls before querying browser state. A transient service-worker or
  // tab-query failure must not leave the whole popup without event handlers.
  void renderRuntimeState();

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode as TermPopMode;
      void saveMode(mode);
    });
  }

  providerInput?.addEventListener("change", () => {
    applyProviderDefaults(providerInput.value as LlmProvider);
    renderProviderTest();
    void saveLlm();
  });

  languageInput?.addEventListener("change", () => {
    void saveLlm();
  });

  llmForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLlm();
  });

  for (const input of [apiKeyInput, modelInput, baseUrlInput, temperatureInput, maxTokensInput, maxConcurrencyInput]) {
    if (!input) {
      continue;
    }
    input.addEventListener("compositionstart", () => {
      composingInputs.add(input);
      cancelLlmAutoSave();
    });
    input.addEventListener("compositionend", () => {
      composingInputs.delete(input);
      scheduleLlmAutoSave();
    });
    input.addEventListener("input", (event) => {
      if (!(event instanceof InputEvent && event.isComposing) && !composingInputs.has(input)) {
        scheduleLlmAutoSave();
      }
    });
    input.addEventListener("change", () => {
      if (!composingInputs.has(input)) {
        scheduleLlmAutoSave();
      }
    });
  }

  providerTestButton?.addEventListener("click", () => {
    void testProviderConnection();
  });

  includeUsageExampleInput?.addEventListener("change", () => {
    void saveLlm();
  });

  screenshotRecognitionEnabledInput?.addEventListener("change", () => {
    void saveLlm();
  });

  screenshotRecognitionModeInput?.addEventListener("change", () => {
    void saveLlm();
  });

  promptTemplateInput?.addEventListener("change", () => {
    currentPromptTemplate = promptTemplateInput.value as PromptTemplateKind;
    renderPromptEditor();
  });

  promptTemplateEditor?.addEventListener("input", () => {
    updatePromptOverrideFromEditor();
    scheduleLlmAutoSave();
  });

  resetPromptTemplateButton?.addEventListener("click", () => {
    delete promptOverrides[currentPromptTemplate];
    renderPromptEditor();
    void saveLlm();
  });

  customizeShortcutButton?.addEventListener("click", () => {
    void openShortcutSettings();
  });

  openGuideButton?.addEventListener("click", () => {
    void openWebsitePage("/guide");
  });

  openDocsButton?.addEventListener("click", () => {
    void openWebsitePage("/docs");
  });

  restoreAllIgnoredTermsButton?.addEventListener("click", () => {
    void restoreAllIgnoredTerms();
  });

  summarizeVisibleButton?.addEventListener("click", () => {
    void sendReadingAssistMessage({ type: "TERMPOP_SUMMARIZE_VISIBLE" } satisfies SummarizeVisibleRequest);
  });

  batchExplainSelectionButton?.addEventListener("click", () => {
    void sendReadingAssistMessage({ type: "TERMPOP_EXPLAIN_SELECTION_TERMS" } satisfies ExplainSelectionTermsRequest);
  });

  exportMarkdownButton?.addEventListener("click", () => {
    void exportLocalData("markdown");
  });

  exportCsvButton?.addEventListener("click", () => {
    void exportLocalData("csv");
  });

  for (const input of [privacyLocalOnlyInput, privacyPreviewBeforeSendInput, privacyDisableScreenshotUploadInput, privacyOnlyExplainSelectionInput]) {
    input?.addEventListener("change", () => {
      void savePrivacySettings();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[IGNORED_TERMS_STORAGE_KEY]) {
      void renderIgnoredTerms();
    }
  });

  advancedToggle?.addEventListener("click", () => {
    const nextVisible = advancedSettings?.hidden ?? true;
    if (advancedSettings) {
      advancedSettings.hidden = !nextVisible;
    }
    if (advancedToggle) {
      advancedToggle.textContent = nextVisible ? t[uiLocale].collapseAdvancedSettings : t[uiLocale].advancedSettings;
    }
    void saveLlm();
  });

  siteAccessToggle?.addEventListener("click", () => {
    void toggleSiteAccess();
  });

  openPdfViewerButton?.addEventListener("click", () => {
    void openPdfViewerForActiveTab();
  });
}

async function renderRuntimeState(): Promise<void> {
  await Promise.allSettled([
    renderSiteAccess(),
    renderPdfToolsVisibility(),
    renderScreenshotShortcut(),
    renderIgnoredTerms()
  ]);
}

async function saveMode(mode: TermPopMode): Promise<void> {
  await enqueueSettingsWrite(() => setMode(mode));
  setActive(mode);
  if (status) {
    status.textContent = t[uiLocale].savedMode;
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
    if (status) status.textContent = t[uiLocale].noCurrentTab;
    return;
  }

  const pdfUrl = extractPdfUrl(sourceUrl);
  if (!pdfUrl) {
    if (status) status.textContent = t[uiLocale].notPdf;
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
  pdfTools.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    pdfTools.hidden = !extractPdfUrl(tab?.url ?? "");
  } catch {
    // A popup must never advertise the PDF viewer without a confirmed PDF tab.
    pdfTools.hidden = true;
  }
}

async function renderSiteAccess(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "TERMPOP_GET_SITE_ACCESS" }) as GetSiteAccessResponse;
    if (!response.ok || !response.access) {
      renderSiteAccessState(undefined, response.error ?? t[uiLocale].readingPermission);
      return;
    }
    renderSiteAccessState(response.access);
  } catch {
    // The background worker can be briefly unavailable while Chrome starts it.
    // Keep the rest of the popup interactive and show a recoverable state.
    renderSiteAccessState(undefined, t[uiLocale].readingPermission);
  }
}

function renderSiteAccessState(access: SiteAccessState | undefined, error?: string): void {
  currentSiteAccess = access;
  siteAccess?.classList.toggle("is-enabled", Boolean(access?.enabled && access.hasPermission));
  siteAccess?.classList.toggle("is-unsupported", Boolean(access && !access.supported));
  if (!access?.supported) {
    if (access && !access.allSitesGranted) {
      if (siteAccessStatus) siteAccessStatus.textContent = t[uiLocale].allSitesRequired;
      if (siteAccessToggle) {
        siteAccessToggle.disabled = false;
        siteAccessToggle.textContent = t[uiLocale].enableAllSites;
      }
      return;
    }
    if (siteAccessStatus) siteAccessStatus.textContent = error || t[uiLocale].unsupportedPage;
    if (siteAccessToggle) {
      siteAccessToggle.disabled = true;
      siteAccessToggle.textContent = t[uiLocale].unavailable;
    }
    return;
  }

  if (access.isFile) {
    if (siteAccessStatus) {
      siteAccessStatus.textContent = access.hasPermission ? t[uiLocale].localFilesEnabled : t[uiLocale].localFilesDisabled;
    }
    if (siteAccessToggle) {
      siteAccessToggle.disabled = false;
      siteAccessToggle.textContent = access.hasPermission ? t[uiLocale].disableLocalFiles : t[uiLocale].enableLocalFiles;
    }
    return;
  }

  if (!access.allSitesGranted) {
    if (siteAccessStatus) siteAccessStatus.textContent = t[uiLocale].allSitesRequired;
    if (siteAccessToggle) {
      siteAccessToggle.disabled = false;
      siteAccessToggle.textContent = t[uiLocale].enableAllSites;
    }
    return;
  }

  if (siteAccessStatus) {
    siteAccessStatus.textContent = access.blocked ? t[uiLocale].blockedOnSite : t[uiLocale].enabledOnSite;
  }
  if (siteAccessToggle) {
    siteAccessToggle.disabled = false;
    siteAccessToggle.textContent = access.blocked ? t[uiLocale].unblockCurrentSite : t[uiLocale].blockCurrentSite;
  }
}

async function toggleSiteAccess(): Promise<void> {
  const access = currentSiteAccess;
  if (!access) {
    renderSiteAccessState(undefined, t[uiLocale].unsupportedPage);
    return;
  }

  if (!access.allSitesGranted && !access.isFile) {
    const granted = await chrome.permissions.request({ origins: [...ALL_SITES_ORIGIN_PATTERNS] });
    if (!granted) {
      if (status) status.textContent = t[uiLocale].permissionDenied;
      return;
    }
    if (access.supported) {
      const saved = await setCurrentSiteEnabled(access.originPattern, true);
      if (!saved) {
        return;
      }
      await injectActiveTab();
    }
    await renderSiteAccess();
    if (status) status.textContent = access.supported ? t[uiLocale].enabledAndInjected : t[uiLocale].enabledRefreshRequired;
    return;
  }

  if (!access.supported) {
    renderSiteAccessState(access, t[uiLocale].unsupportedPage);
    return;
  }

  if (access.isFile) {
    const nextEnabled = !access.hasPermission;
    if (nextEnabled) {
      const granted = await chrome.permissions.request({ origins: [FILE_ORIGIN_PATTERN] });
      if (!granted) {
        if (status) status.textContent = t[uiLocale].permissionDenied;
        return;
      }
    } else {
      await disableActiveTabContent();
      await chrome.permissions.remove({ origins: [FILE_ORIGIN_PATTERN] });
    }
    await renderSiteAccess();
    if (nextEnabled) {
      await injectActiveTab();
    }
    return;
  }

  const nextEnabled = access.blocked;
  if (!nextEnabled) {
    await disableActiveTabContent();
  }
  const saved = await setCurrentSiteEnabled(access.originPattern, nextEnabled);
  if (!saved) {
    return;
  }
  renderSiteAccessState(saved);
  if (nextEnabled) {
    await injectActiveTab();
    if (status) status.textContent = t[uiLocale].unblockedAndInjected;
  } else if (status) {
    status.textContent = t[uiLocale].disabledAndCleaned;
  }
}

async function setCurrentSiteEnabled(originPattern: string, enabled: boolean): Promise<SiteAccessState | undefined> {
  const response = await chrome.runtime.sendMessage({
    type: "TERMPOP_SET_SITE_ACCESS",
    originPattern,
    enabled
  }) as SetSiteAccessResponse;
  if (!response.ok || !response.access) {
    renderSiteAccessState(undefined, response.error ?? t[uiLocale].saveSiteAccessFailed);
    return undefined;
  }
  return response.access;
}

async function injectActiveTab(): Promise<void> {
  const injected = await chrome.runtime.sendMessage({ type: "TERMPOP_INJECT_ACTIVE_TAB" }) as InjectActiveTabResponse;
  if (status && (!injected.ok || !injected.injected)) {
    status.textContent = t[uiLocale].enabledRefreshRequired;
  }
}

async function disableActiveTabContent(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TERMPOP_DISABLE_SITE" } satisfies DisableSiteRequest) as DisableSiteResponse;
  } catch {
    // The page may not have a TermPop content script yet; disabling permissions should still continue.
  }
}

async function saveLlm(): Promise<void> {
  cancelLlmAutoSave();

  const llm = collectLlmSettings();
  const saveId = ++latestLlmSaveId;
  await enqueueSettingsWrite(() => setLlmSettings(llm));
  if (saveId !== latestLlmSaveId) {
    return;
  }
  renderAppName();
  renderModeLabels();
  renderProviderTest();
  if (status) {
    status.textContent = llm.apiKey ? t[uiLocale].savedLlm : t[uiLocale].savedUnconfigured;
  }
}

async function testProviderConnection(): Promise<void> {
  const settings = collectLlmSettings();
  if (!settings.apiKey) {
    if (status) status.textContent = t[uiLocale].providerApiKeyRequired;
    return;
  }

  const originPattern = providerOriginPatternFromBaseUrl(settings.baseUrl);
  if (!originPattern) {
    if (status) status.textContent = t[uiLocale].providerBaseUrlInvalid;
    return;
  }

  if (!currentSiteAccess?.allSitesGranted) {
    if (status) status.textContent = t[uiLocale].providerNeedsAllSites;
    return;
  }

  if (providerTestButton) {
    providerTestButton.disabled = true;
    providerTestButton.textContent = t[uiLocale].testingProvider;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TERMPOP_TEST_LLM_PROVIDER",
      settings
    }) as TestLlmProviderResponse;
    if (!response.ok) {
      if (status) status.textContent = `${t[uiLocale].providerTestFailed}: ${response.error ?? ""}`.trim();
      return;
    }
    await setLlmSettings(settings);
    if (status) status.textContent = t[uiLocale].providerTestSucceeded;
  } catch (error) {
    if (status) status.textContent = `${t[uiLocale].providerTestFailed}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    renderProviderTest();
  }
}

function scheduleLlmAutoSave(): void {
  cancelLlmAutoSave();
  if (status) {
    status.textContent = t[uiLocale].saving;
  }
  autoSaveTimer = window.setTimeout(() => {
    void saveLlm();
  }, AUTO_SAVE_DELAY_MS);
}

function cancelLlmAutoSave(): void {
  if (autoSaveTimer === undefined) {
    return;
  }
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = undefined;
}

function enqueueSettingsWrite(write: () => Promise<void>): Promise<void> {
  const queued = settingsWriteChain.catch(() => undefined).then(write);
  settingsWriteChain = queued;
  return queued;
}

function collectLlmSettings(): LlmSettings {
  const llm: LlmSettings = {
    provider: (providerInput?.value || "openai") as LlmProvider,
    apiKey: apiKeyInput?.value.trim() || "",
    model: modelInput?.value.trim() || "",
    baseUrl: normalizeBaseUrl(baseUrlInput?.value.trim() || defaultBaseUrl((providerInput?.value || "openai") as LlmProvider)),
    language: (languageInput?.value || "auto") as ExplanationLanguage,
    includeUsageExample: includeUsageExampleInput?.checked ?? false,
    screenshotRecognitionEnabled: screenshotRecognitionEnabledInput?.checked ?? true,
    screenshotRecognitionMode: (screenshotRecognitionModeInput?.value || "auto") as ScreenshotRecognitionMode,
    maxConcurrency: Math.round(clampNumber(Number(maxConcurrencyInput?.value), 1, Number.MAX_SAFE_INTEGER, 5)),
    temperature: clampNumber(Number(temperatureInput?.value), 0, 2, 0.2),
    maxTokens: Math.round(clampNumber(Number(maxTokensInput?.value), 128, 4000, 450)),
    promptOverrides: { ...promptOverrides },
    advancedVisible: advancedSettings ? !advancedSettings.hidden : false,
    debugLogging: false
  };
  return llm;
}

function renderAppName(): void {
  const name = "TermPop";
  document.title = name;
  if (appTitle) {
    appTitle.textContent = name;
  }
}

function renderModeLabels(): void {
  for (const button of buttons) {
    const mode = button.dataset.mode as TermPopMode | undefined;
    if (mode && mode in t[uiLocale].modes) {
      button.textContent = t[uiLocale].modes[mode as keyof typeof t.zh.modes];
    }
  }
}

function renderLlmSettings(llm: LlmSettings): void {
  promptOverrides = { ...llm.promptOverrides };
  renderNormalizedLlmFields(llm);
  renderAdvancedSettings(llm);
  renderPromptEditor();
  renderProviderTest();
}

function renderPrivacySettings(privacy: PrivacySettings): void {
  if (privacyLocalOnlyInput) privacyLocalOnlyInput.checked = privacy.localOnlyDictionary;
  if (privacyPreviewBeforeSendInput) privacyPreviewBeforeSendInput.checked = privacy.previewBeforeSend;
  if (privacyDisableScreenshotUploadInput) privacyDisableScreenshotUploadInput.checked = privacy.disableScreenshotUpload;
  if (privacyOnlyExplainSelectionInput) privacyOnlyExplainSelectionInput.checked = privacy.onlyExplainSelection;
}

function collectPrivacySettings(): PrivacySettings {
  return {
    localOnlyDictionary: privacyLocalOnlyInput?.checked ?? false,
    previewBeforeSend: privacyPreviewBeforeSendInput?.checked ?? false,
    disableScreenshotUpload: privacyDisableScreenshotUploadInput?.checked ?? false,
    onlyExplainSelection: privacyOnlyExplainSelectionInput?.checked ?? false
  };
}

async function savePrivacySettings(): Promise<void> {
  await enqueueSettingsWrite(() => setPrivacySettings(collectPrivacySettings()));
  if (status) {
    status.textContent = uiLocale === "zh" ? "隐私设置已自动保存。" : "Privacy settings saved automatically.";
  }
}

async function sendReadingAssistMessage(message: SummarizeVisibleRequest | ExplainSelectionTermsRequest): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    if (status) status.textContent = t[uiLocale].noCurrentTab;
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message) as { ok?: boolean; error?: string };
    if (!response?.ok) {
      throw new Error(response?.error || t[uiLocale].readingAssistFailed);
    }
    if (status) status.textContent = t[uiLocale].readingAssistSent;
    window.close();
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : t[uiLocale].readingAssistFailed;
  }
}

async function exportLocalData(format: "markdown" | "csv"): Promise<void> {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get(IGNORED_TERMS_STORAGE_KEY);
  const ignored = parseIgnoredTerms(stored[IGNORED_TERMS_STORAGE_KEY]);
  const userTerms = settings.dictionary.user;
  const content = format === "markdown"
    ? toMarkdownExport(userTerms, ignored.map((entry) => entry.term))
    : toCsvExport(userTerms, ignored.map((entry) => entry.term));
  const extension = format === "markdown" ? "md" : "csv";
  const mime = format === "markdown" ? "text/markdown;charset=utf-8" : "text/csv;charset=utf-8";
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `termpop-local-data-${new Date().toISOString().slice(0, 10)}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
  if (status) status.textContent = t[uiLocale].exportSucceeded;
}

function toMarkdownExport(userTerms: Awaited<ReturnType<typeof getSettings>>["dictionary"]["user"], ignoredTerms: string[]): string {
  const lines = ["# TermPop local data", "", "## User dictionary", "", "| Term | Type | Confidence |", "| --- | --- | --- |"];
  for (const entry of userTerms) {
    lines.push(`| ${escapeExportCell(entry.term)} | ${entry.term_type ?? "Custom"} | ${entry.confidence ?? ""} |`);
  }
  lines.push("", "## Ignored terms", "");
  for (const term of ignoredTerms) lines.push(`- ${term}`);
  return `${lines.join("\n")}\n`;
}

function toCsvExport(userTerms: Awaited<ReturnType<typeof getSettings>>["dictionary"]["user"], ignoredTerms: string[]): string {
  const lines = ["kind,term,term_type,confidence"];
  for (const entry of userTerms) lines.push(["user_dictionary", entry.term, entry.term_type ?? "Custom", entry.confidence ?? ""].map(csvCell).join(","));
  for (const term of ignoredTerms) lines.push(["ignored_term", term, "", ""].map(csvCell).join(","));
  return `\uFEFF${lines.join("\n")}\n`;
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function escapeExportCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function renderProviderTest(): void {
  if (!providerTestButton || !providerInput) {
    return;
  }
  providerTestButton.disabled = false;
  providerTestButton.textContent = t[uiLocale].testProvider;
}

function renderNormalizedLlmFields(llm: LlmSettings): void {
  if (providerInput) providerInput.value = llm.provider;
  if (apiKeyInput) apiKeyInput.value = llm.apiKey;
  if (modelInput) modelInput.value = llm.model;
  if (baseUrlInput) baseUrlInput.value = llm.baseUrl;
  if (languageInput) languageInput.value = llm.language;
  if (includeUsageExampleInput) includeUsageExampleInput.checked = llm.includeUsageExample;
  if (screenshotRecognitionEnabledInput) screenshotRecognitionEnabledInput.checked = llm.screenshotRecognitionEnabled;
  if (screenshotRecognitionModeInput) screenshotRecognitionModeInput.value = llm.screenshotRecognitionMode;
  if (maxConcurrencyInput) maxConcurrencyInput.value = String(llm.maxConcurrency);
  if (temperatureInput) temperatureInput.value = String(llm.temperature);
  if (maxTokensInput) maxTokensInput.value = String(llm.maxTokens);
}

async function renderScreenshotShortcut(): Promise<void> {
  if (!screenshotShortcut) {
    return;
  }
  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === "explain-screenshot");
  screenshotShortcut.textContent = command?.shortcut || t[uiLocale].shortcutUnassigned;
}

async function openShortcutSettings(): Promise<void> {
  const scheme = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
  await chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` });
  window.close();
}

async function openWebsitePage(path: "/guide" | "/docs"): Promise<void> {
  await chrome.tabs.create({ url: termpopWebsiteUrl(path, "extension") });
  window.close();
}

function renderAdvancedSettings(llm: LlmSettings): void {
  if (advancedSettings) {
    advancedSettings.hidden = !llm.advancedVisible;
  }
  if (advancedToggle) {
    advancedToggle.textContent = llm.advancedVisible ? t[uiLocale].collapseAdvancedSettings : t[uiLocale].advancedSettings;
  }
}

function renderPromptEditor(): void {
  if (!promptTemplateInput || !promptTemplateEditor) {
    return;
  }
  const templates: Array<[PromptTemplateKind, string]> = [
    ["detection", t[uiLocale].promptEditorDetection],
    ["explanation", t[uiLocale].promptEditorExplanation],
    ["screenshot", t[uiLocale].promptEditorScreenshot],
    ["followUp", t[uiLocale].promptEditorFollowUp]
  ];
  const currentValue = promptTemplateInput.value;
  promptTemplateInput.replaceChildren(...templates.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  const selected = templates.some(([value]) => value === currentValue) ? currentValue : currentPromptTemplate;
  currentPromptTemplate = selected as PromptTemplateKind;
  promptTemplateInput.value = currentPromptTemplate;
  promptTemplateEditor.value = promptInstruction(currentPromptTemplate, promptOverrides[currentPromptTemplate]);
}

function updatePromptOverrideFromEditor(): void {
  if (!promptTemplateEditor) {
    return;
  }
  const value = promptTemplateEditor.value.trim();
  const defaultValue = promptInstruction(currentPromptTemplate).trim();
  if (!value || value === defaultValue) {
    delete promptOverrides[currentPromptTemplate];
    return;
  }
  promptOverrides[currentPromptTemplate] = value;
}

async function renderIgnoredTerms(): Promise<void> {
  if (!ignoredTermsList) {
    return;
  }
  const stored = await chrome.storage.local.get(IGNORED_TERMS_STORAGE_KEY);
  const terms = parseIgnoredTerms(stored[IGNORED_TERMS_STORAGE_KEY]);
  ignoredTermsList.replaceChildren();
  if (restoreAllIgnoredTermsButton) {
    restoreAllIgnoredTermsButton.hidden = terms.length === 0;
  }
  if (terms.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ignored-terms-empty";
    empty.textContent = t[uiLocale].ignoredTermsEmpty;
    ignoredTermsList.append(empty);
    return;
  }
  for (const entry of terms.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "ignored-term-row";
    const term = document.createElement("span");
    term.textContent = entry.term;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = t[uiLocale].restoreTerm;
    restore.addEventListener("click", () => {
      void restoreIgnoredTerm(entry.term);
    });
    row.append(term, restore);
    ignoredTermsList.append(row);
  }
}

async function restoreIgnoredTerm(term: string): Promise<void> {
  await removeIgnoredTerm(term);
  await renderIgnoredTerms();
}

async function restoreAllIgnoredTerms(): Promise<void> {
  await clearIgnoredTerms();
  await renderIgnoredTerms();
}

function applyUiLocale(): void {
  document.documentElement.lang = uiLocale === "zh" ? "zh-CN" : "en";
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    const key = element.dataset.i18n as keyof typeof t.zh | undefined;
    if (key && typeof t[uiLocale][key] === "string") {
      element.textContent = t[uiLocale][key];
    }
  }
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n-attr]"))) {
    const rules = element.dataset.i18nAttr?.split(",") ?? [];
    for (const rule of rules) {
      const [attribute, key] = rule.split(":").map((part) => part.trim());
      if (attribute && key && key in t[uiLocale] && typeof t[uiLocale][key as keyof typeof t.zh] === "string") {
        element.setAttribute(attribute, t[uiLocale][key as keyof typeof t.zh] as string);
      }
    }
  }
  if (siteAccessStatus) siteAccessStatus.textContent = t[uiLocale].readingPermission;
  if (siteAccessToggle) siteAccessToggle.textContent = t[uiLocale].enableAllSites;
  if (openPdfViewerButton) openPdfViewerButton.textContent = t[uiLocale].pdfButton;
}

function applyProviderDefaults(provider: LlmProvider): void {
  if (modelInput) {
    modelInput.value = "";
  }
  if (baseUrlInput) {
    baseUrlInput.value = defaultBaseUrl(provider);
  }
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
