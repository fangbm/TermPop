import { getSettings } from "../shared/settings";
import type {
  BeginScreenshotSelectionRequest,
  BeginScreenshotSelectionResponse,
  RecognizeScreenshotRequest,
  ScreenshotRecognition
} from "../shared/types";
import { createLlmProvider } from "./llm-provider";
import { assertLlmProviderAuthorized } from "./provider-access";
import { injectContentScriptForTab, isUrlEnabled } from "./site-access";
import { sanitizeForLog } from "./utils";
import { assertScreenshotDataUrl } from "./vision";

const SCREENSHOT_COMMAND = "explain-screenshot";

export function setupScreenshotCommand(): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== SCREENSHOT_COMMAND || tab.id === undefined) {
      return;
    }
    void beginScreenshotSelection(tab).catch((error: unknown) => {
      console.warn("TermPop screenshot selection could not start.", sanitizeForLog(error, 300));
      void showCommandFailureBadge(tab.id);
    });
  });
}

export async function captureVisibleSenderTab(sender: chrome.runtime.MessageSender): Promise<string> {
  if (sender.tab?.id === undefined || sender.tab.windowId === undefined) {
    throw new Error("Screenshot capture must be started from a web page.");
  }
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
  if (activeTab?.id !== sender.tab.id) {
    throw new Error("Keep the selected page active while capturing the screenshot.");
  }
  return chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
}

export async function recognizeScreenshot(request: RecognizeScreenshotRequest): Promise<ScreenshotRecognition> {
  assertScreenshotDataUrl(request.termImageDataUrl);
  assertScreenshotDataUrl(request.contextImageDataUrl);
  const settings = await getSettings();
  if (settings.llm.provider === "mock" || !settings.llm.apiKey.trim()) {
    throw new Error(screenshotCopy[uiLocale()].providerRequired);
  }
  await assertLlmProviderAuthorized(settings.llm);
  return createLlmProvider(settings.llm).recognizeSelection(
    request.termImageDataUrl,
    request.contextImageDataUrl,
    settings.llm
  );
}

async function beginScreenshotSelection(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url || !await isUrlEnabled(tab.url)) {
    throw new Error("TermPop is not enabled on this site.");
  }
  if (!await injectContentScriptForTab(tab.id, tab.url)) {
    throw new Error("TermPop could not access this page.");
  }
  const message = { type: "TERMPOP_BEGIN_SCREENSHOT_SELECTION" } satisfies BeginScreenshotSelectionRequest;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, message) as BeginScreenshotSelectionResponse;
      if (!response.ok) {
        throw new Error(response.error || "Screenshot selection could not start.");
      }
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function showCommandFailureBadge(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) {
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#dc2626" });
  await chrome.action.setBadgeText({ tabId, text: "!" });
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" });
  }, 2500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const screenshotCopy = {
  zh: {
    providerRequired: "截图识词需要在插件设置中配置支持图片输入的多模态 LLM。"
  },
  en: {
    providerRequired: "Screenshot recognition requires a multimodal LLM configured in extension settings."
  }
} as const;

function uiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? "en";
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}
