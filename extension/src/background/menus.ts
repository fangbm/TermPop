import { getSettings } from "../shared/settings";
import type { ExplainSelectionRequest } from "../shared/types";
import { BLOCKED_SITES_STORAGE_KEY } from "../shared/browser-utils";
import { isUrlEnabled } from "./site-access";
import { sanitizeForLog } from "./utils";

const SELECTION_CONTEXT_MENU_ID = "termpop-explain-selection";
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
    if (info.menuItemId !== SELECTION_CONTEXT_MENU_ID || !tab?.id || !info.selectionText?.trim()) {
      return;
    }

    void getSettings().then(async (settings) => {
      if (settings.mode === "hover") {
        return;
      }
      if (!tab.url || !await isUrlEnabled(tab.url)) {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id as number, {
          type: "TERMPOP_EXPLAIN_SELECTION",
          term: info.selectionText ?? ""
        } satisfies ExplainSelectionRequest);
      } catch (error) {
        console.warn("TermPop selection explain could not run on this page.", sanitizeForLog(error, 300));
      }
    });
  });
}

export async function syncContextMenus(): Promise<void> {
  const settings = await getSettings();
  const visible = (settings.mode === "selection" || settings.mode === "hybrid") && await isActiveTabEnabled();
  const title = uiLocale() === "zh" ? "用 TermPop 解释选中文本" : "Explain selection with TermPop";

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
}

function uiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? "en";
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}

async function isActiveTabEnabled(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Boolean(tab?.url && await isUrlEnabled(tab.url));
}
