import type { SiteAccessState } from "../shared/types";
import {
  ALL_SITES_ORIGIN_PATTERNS,
  BLOCKED_SITES_STORAGE_KEY,
  FILE_ORIGIN_PATTERN,
  LEGACY_SITE_ACCESS_STORAGE_KEY,
  originPatternFromUrl
} from "../shared/browser-utils";
import { sanitizeForLog } from "./utils";
import { isSiteEnabledByPolicy } from "./site-access-policy";

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
      hasPermission: false,
      allSitesGranted: await hasAllSitesAccess(),
      blocked: false,
      isFile: false
    };
  }

  const isFile = originPattern === FILE_ORIGIN_PATTERN;
  const [allSitesGranted, blockedOrigins] = await Promise.all([
    hasAllSitesAccess(),
    getBlockedOrigins()
  ]);
  const blocked = !isFile && blockedOrigins.includes(originPattern);
  const hasPermission = isFile
    ? await chrome.permissions.contains({ origins: [FILE_ORIGIN_PATTERN] })
    : allSitesGranted;
  const enabled = isSiteEnabledByPolicy({
    originPattern,
    allSitesGranted,
    isFile,
    filePermission: hasPermission,
    blockedOrigins
  });
  return {
    url,
    originPattern,
    supported: true,
    enabled,
    hasPermission,
    allSitesGranted,
    blocked,
    isFile
  };
}

export async function setOriginEnabled(originPattern: string, enabled: boolean): Promise<void> {
  if (originPattern === FILE_ORIGIN_PATTERN) {
    return;
  }

  const origins = new Set(await getBlockedOrigins());
  if (enabled) {
    origins.delete(originPattern);
  } else {
    origins.add(originPattern);
  }
  await chrome.storage.local.set({ [BLOCKED_SITES_STORAGE_KEY]: [...origins] });
  await chrome.storage.local.remove(LEGACY_SITE_ACCESS_STORAGE_KEY);
}

export async function isUrlEnabled(url: string | undefined): Promise<boolean> {
  const originPattern = originPatternFromUrl(url ?? "");
  if (!originPattern) {
    return false;
  }

  const isFile = originPattern === FILE_ORIGIN_PATTERN;
  const [allSitesGranted, blockedOrigins, filePermission] = await Promise.all([
    hasAllSitesAccess(),
    getBlockedOrigins(),
    isFile
      ? chrome.permissions.contains({ origins: [FILE_ORIGIN_PATTERN] })
      : Promise.resolve(false)
  ]);
  return isSiteEnabledByPolicy({
    originPattern,
    allSitesGranted,
    isFile,
    filePermission,
    blockedOrigins
  });
}

export async function hasAllSitesAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...ALL_SITES_ORIGIN_PATTERNS] });
}

export async function migrateLegacySiteAccess(): Promise<void> {
  await chrome.storage.local.remove([LEGACY_SITE_ACCESS_STORAGE_KEY, "termpop.authorizedProviderOrigins"]);

  // Old releases granted individual site and provider origins. Remove those
  // grants before the user opts into the new all-sites permission model.
  if (!await hasAllSitesAccess()) {
    const permissions = await chrome.permissions.getAll();
    const legacyOrigins = (permissions.origins ?? []).filter((origin) =>
      origin !== FILE_ORIGIN_PATTERN
      && !ALL_SITES_ORIGIN_PATTERNS.includes(origin as typeof ALL_SITES_ORIGIN_PATTERNS[number])
    );
    if (legacyOrigins.length > 0) {
      await chrome.permissions.remove({ origins: legacyOrigins });
    }
  }
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

async function getBlockedOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(BLOCKED_SITES_STORAGE_KEY);
  return Array.isArray(stored[BLOCKED_SITES_STORAGE_KEY])
    ? stored[BLOCKED_SITES_STORAGE_KEY].filter((value): value is string => typeof value === "string")
    : [];
}
