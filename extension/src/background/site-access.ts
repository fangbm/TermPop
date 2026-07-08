import type { SiteAccessState } from "../shared/types";
import { originPatternFromUrl, SITE_ACCESS_STORAGE_KEY } from "../shared/browser-utils";
import { sanitizeForLog } from "./utils";

export async function getSiteAccessForActiveTab(): Promise<SiteAccessState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return getSiteAccessForTab(tab);
}

export async function getSiteAccessForTab(tab: chrome.tabs.Tab | undefined): Promise<SiteAccessState> {
  const url = tab?.url ?? "";
  const originPattern = originPatternFromUrl(url);
  if (!originPattern) {
    return {
      url,
      originPattern: "",
      supported: false,
      enabled: false,
      hasPermission: false
    };
  }

  const enabledOrigins = await getEnabledOrigins();
  const enabled = enabledOrigins.includes(originPattern);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  return {
    url,
    originPattern,
    supported: true,
    enabled,
    hasPermission
  };
}

export async function setOriginEnabled(originPattern: string, enabled: boolean): Promise<void> {
  const origins = new Set(await getEnabledOrigins());
  if (enabled) {
    origins.add(originPattern);
  } else {
    origins.delete(originPattern);
  }
  await chrome.storage.local.set({ [SITE_ACCESS_STORAGE_KEY]: [...origins] });
}

export async function isUrlEnabled(url: string | undefined): Promise<boolean> {
  const originPattern = originPatternFromUrl(url ?? "");
  if (!originPattern) {
    return false;
  }
  const origins = await getEnabledOrigins();
  if (!origins.includes(originPattern)) {
    return false;
  }
  return chrome.permissions.contains({ origins: [originPattern] });
}

export async function injectContentScriptForTab(tabId: number, url: string | undefined): Promise<boolean> {
  if (!await isUrlEnabled(url)) {
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-loader.js"]
    });
    return true;
  } catch (error) {
    console.warn("TermPop could not inject content script.", sanitizeForLog(error, 300));
    return false;
  }
}

export async function injectActiveTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return false;
  }
  return injectContentScriptForTab(tab.id, tab.url);
}

async function getEnabledOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(SITE_ACCESS_STORAGE_KEY);
  return Array.isArray(stored[SITE_ACCESS_STORAGE_KEY])
    ? stored[SITE_ACCESS_STORAGE_KEY].filter((value): value is string => typeof value === "string")
    : [];
}
