import { getSettings } from "../shared/settings";
import type { ExplainSelectionRequest, ExplainSelectionTermsRequest } from "../shared/types";
import { BLOCKED_SITES_STORAGE_KEY } from "../shared/browser-utils";
import { injectContentScriptForTab, isUrlEnabled } from "./site-access";
import { sanitizeForLog } from "./utils";

const SELECTION_CONTEXT_MENU_ID = "termpop-explain-selection";
const BATCH_SELECTION_CONTEXT_MENU_ID = "termpop-explain-selection-terms";
const SETTINGS_KEY = "termpop.settings";

export function setupContextMenus(): void {
  void syncContextMenus();

  chrome.runtime.onInstalled.addListener(() => {
    void syncContextMenus();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes[SETTINGS_KEY] || changes[BLOCKED_SITES_STORAGE_KEY])) {
      void syncContextMenus();
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    void syncContextMenus();
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === "complete" || changeInfo.url) {
      void syncContextMenus();
    }
  });

  chrome.permissions.onAdded.addListener(() => {
    void syncContextMenus();
  });

  chrome.permissions.onRemoved.addListener(() => {
    void syncContextMenus();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if ((info.menuItemId !== SELECTION_CONTEXT_MENU_ID && info.menuItemId !== BATCH_SELECTION_CONTEXT_MENU_ID) || !tab?.id || !info.selectionText?.trim()) {
      return;
    }

    void getSettings().then(async (settings) => {
      if (settings.mode === "hover" && !settings.privacy.onlyExplainSelection) {
        return;
      }
      if (!tab.url || !await isUrlEnabled(tab.url)) {
        return;
      }
      try {
        const message = info.menuItemId === BATCH_SELECTION_CONTEXT_MENU_ID
          ? { type: "TERMPOP_EXPLAIN_SELECTION_TERMS" } satisfies ExplainSelectionTermsRequest
          : { type: "TERMPOP_EXPLAIN_SELECTION", term: info.selectionText ?? "" } satisfies ExplainSelectionRequest;
        if (!await injectContentScriptForTab(tab.id as number, tab.url)) {
          return;
        }
        await sendSelectionMessageWhenReady(tab.id as number, message);
      } catch (error) {
        console.warn("TermPop selection explain could not run on this page.", sanitizeForLog(error, 300));
      }
    });
  });
}

export async function syncContextMenus(): Promise<void> {
  const settings = await getSettings();
  const visible = (settings.mode === "selection" || settings.mode === "hybrid" || settings.privacy.onlyExplainSelection) && await isActiveTabEnabled();
  const title = uiLocale() === "zh" ? "用 TermPop 解释选中文本" : "Explain selection with TermPop";
  const batchTitle = uiLocale() === "zh" ? "用 TermPop 批量解释选区术语" : "Explain key terms in selection";

  chrome.contextMenus.update(SELECTION_CONTEXT_MENU_ID, { title, visible }, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    chrome.contextMenus.create(
      {
        id: SELECTION_CONTEXT_MENU_ID,
        title,
        contexts: ["selection"],
        visible
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });

  chrome.contextMenus.update(BATCH_SELECTION_CONTEXT_MENU_ID, { title: batchTitle, visible }, () => {
    if (!chrome.runtime.lastError) {
      return;
    }
    chrome.contextMenus.create(
      {
        id: BATCH_SELECTION_CONTEXT_MENU_ID,
        title: batchTitle,
        contexts: ["selection"],
        visible
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

async function sendSelectionMessageWhenReady(
  tabId: number,
  message: ExplainSelectionRequest | ExplainSelectionTermsRequest
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error("TermPop content script did not become ready.");
}

function uiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? "en";
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}

async function isActiveTabEnabled(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Boolean(tab?.url && await isUrlEnabled(tab.url));
}
