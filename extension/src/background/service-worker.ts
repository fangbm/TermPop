import { getSettings } from "../shared/settings";
import type {
  AddCachedTermsRequest,
  AddCachedTermsResponse,
  DetectTermsRequest,
  DetectTermsResponse,
  ExplainRequest,
  ExplainResponse,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  GetSiteAccessRequest,
  GetSiteAccessResponse,
  InjectActiveTabRequest,
  InjectActiveTabResponse,
  SetSiteAccessRequest,
  SetSiteAccessResponse
} from "../shared/types";
import { addCachedTerms, getCachedTerms } from "./cache";
import { detectTerms } from "./detection";
import { explain } from "./explanations";
import { setupContextMenus } from "./menus";
import { getSiteAccessForActiveTab, injectActiveTab, injectContentScriptForTab, isUrlEnabled, setOriginEnabled } from "./site-access";

type RuntimeMessage =
  | ExplainRequest
  | DetectTermsRequest
  | GetCachedTermsRequest
  | AddCachedTermsRequest
  | GetSiteAccessRequest
  | SetSiteAccessRequest
  | InjectActiveTabRequest;

interface CacheContextMessage {
  url?: string;
  pageFingerprint?: string;
}

setupContextMenus();
setupDynamicInjection();

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "TERMPOP_GET_SITE_ACCESS") {
    getSiteAccessForActiveTab()
      .then((access) => sendResponse({ ok: true, access } satisfies GetSiteAccessResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies GetSiteAccessResponse));
    return true;
  }

  if (message.type === "TERMPOP_SET_SITE_ACCESS") {
    setOriginEnabled(message.originPattern, message.enabled)
      .then(getSiteAccessForActiveTab)
      .then((access) => sendResponse({ ok: true, access } satisfies SetSiteAccessResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies SetSiteAccessResponse));
    return true;
  }

  if (message.type === "TERMPOP_INJECT_ACTIVE_TAB") {
    injectActiveTab()
      .then((injected) => sendResponse({ ok: true, injected } satisfies InjectActiveTabResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies InjectActiveTabResponse));
    return true;
  }

  if (message.type === "TERMPOP_GET_CACHED_TERMS") {
    ensureSenderCanUsePageServices(sender)
      .then(() => getCachedTerms(cacheContextFromMessage(message, sender)))
      .then((terms) => sendResponse({ ok: true, terms } satisfies GetCachedTermsResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies GetCachedTermsResponse));
    return true;
  }

  if (message.type === "TERMPOP_ADD_CACHED_TERMS") {
    ensureSenderCanUsePageServices(sender)
      .then(() => addCachedTerms(message.terms, cacheContextFromMessage(message, sender), message.scope))
      .then(() => sendResponse({ ok: true } satisfies AddCachedTermsResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies AddCachedTermsResponse));
    return true;
  }

  if (message.type === "TERMPOP_DETECT_TERMS") {
    ensureSenderCanUsePageServices(sender)
      .then(getSettings)
      .then((settings) => {
        const requestedMode = message.detectionMode ?? "all";
        // LLM-backed detection sends page text to the configured provider and
        // can be triggered automatically on DOM changes, so cap it per tab.
        // When the limit is hit, silently fall back to local Rust detection.
        const mode = requestedMode === "primary" || consumeRateAllowance(sender, "detect")
          ? requestedMode
          : "primary";
        return detectTerms(message.text, mode, {
          llm: settings.llm,
          dictionaryJson: buildDictionaryJson(settings.dictionary)
        }, cacheContextFromMessage(message, sender));
      })
      .then((result) => sendResponse({ ok: true, terms: result.terms, debug: result.debug } satisfies DetectTermsResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies DetectTermsResponse));
    return true;
  }

  if (message.type === "TERMPOP_EXPLAIN") {
    ensureSenderCanUsePageServices(sender)
      .then(() => {
        // Hover cards are user-facing, but pages can synthesize mouse events,
        // so cap explanation requests per tab as well.
        if (!consumeRateAllowance(sender, "explain")) {
          throw new Error("TermPop rate limit reached; try again shortly.");
        }
      })
      .then(getSettings)
      .then((settings) => explain(message.term, message.context, message.cacheScope, message.refresh ?? false, settings.llm))
      .then((explanation) => sendResponse({ ok: true, explanation } satisfies ExplainResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies ExplainResponse));
    return true;
  }

  return false;
});

type RateLimitKind = "detect" | "explain";

const RATE_LIMITS: Record<RateLimitKind, { maxRequests: number; windowMs: number }> = {
  detect: { maxRequests: 12, windowMs: 60_000 },
  explain: { maxRequests: 60, windowMs: 60_000 }
};

const rateLimitBuckets = new Map<string, number[]>();

// Best-effort sliding-window limiter. Counters live in service-worker memory
// and reset when the worker suspends, which is acceptable for cost control.
function consumeRateAllowance(sender: chrome.runtime.MessageSender, kind: RateLimitKind): boolean {
  const { maxRequests, windowMs } = RATE_LIMITS[kind];
  const key = `${kind}:${sender.tab?.id ?? sender.url ?? "extension"}`;
  const now = Date.now();
  const windowStart = now - windowMs;
  const bucket = (rateLimitBuckets.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
  if (bucket.length >= maxRequests) {
    rateLimitBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
  return true;
}

function setupDynamicInjection(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") {
      return;
    }
    void injectContentScriptForTab(tabId, tab.url);
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    void chrome.tabs.get(activeInfo.tabId).then((tab) => {
      if (tab.id !== undefined) {
        void injectContentScriptForTab(tab.id, tab.url);
      }
    });
  });
}

function buildDictionaryJson(dictionary: Awaited<ReturnType<typeof getSettings>>["dictionary"]): string | undefined {
  if (!dictionary.base.length && !dictionary.domain.length && !dictionary.user.length) {
    return undefined;
  }
  return JSON.stringify(dictionary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSenderCanUsePageServices(sender: chrome.runtime.MessageSender): Promise<void> {
  const senderUrl = senderUrlForAccessCheck(sender);
  if (!senderUrl || isExtensionUrl(senderUrl)) {
    return;
  }
  if (!await isUrlEnabled(senderUrl)) {
    throw new Error("TermPop is not enabled on this site.");
  }
}

function cacheContextFromMessage(
  message: CacheContextMessage,
  sender: chrome.runtime.MessageSender
): { url?: string; pageFingerprint?: string } {
  const senderUrl = senderUrlForAccessCheck(sender);
  const canUseMessageUrl = !senderUrl || isExtensionUrl(senderUrl);
  return {
    url: canUseMessageUrl ? message.url ?? senderUrl : senderUrl,
    pageFingerprint: message.pageFingerprint
  };
}

function senderUrlForAccessCheck(sender: chrome.runtime.MessageSender): string | undefined {
  return sender.tab?.url ?? sender.url;
}

function isExtensionUrl(value: string): boolean {
  return value.startsWith(chrome.runtime.getURL(""));
}
