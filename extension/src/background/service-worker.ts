import { getSettings } from "../shared/settings";
import type {
  AddCachedTermsRequest,
  AddCachedTermsResponse,
  CaptureVisibleTabRequest,
  CaptureVisibleTabResponse,
  DetectTermsRequest,
  DetectTermsResponse,
  ExplainRequest,
  ExplainResponse,
  FollowUpRequest,
  FollowUpResponse,
  FollowUpStreamDone,
  FollowUpStreamError,
  FollowUpStreamStart,
  GetCachedTermsRequest,
  GetCachedTermsResponse,
  GetSiteAccessRequest,
  GetSiteAccessResponse,
  InjectActiveTabRequest,
  InjectActiveTabResponse,
  DisableSiteRequest,
  IgnoreTermRequest,
  IgnoreTermResponse,
  RecognizeScreenshotRequest,
  RecognizeScreenshotResponse,
  TestLlmProviderRequest,
  TestLlmProviderResponse,
  SetSiteAccessRequest,
  SetSiteAccessResponse
} from "../shared/types";
import { ALL_SITES_ORIGIN_PATTERNS, BLOCKED_SITES_STORAGE_KEY, FILE_ORIGIN_PATTERN } from "../shared/browser-utils";
import { addCachedTerms, getCachedTerms } from "./cache";
import { addIgnoredTerm } from "../shared/ignored-terms";
import { detectTerms } from "./detection";
import { explain, followUp, followUpStream } from "./explanations";
import { setupContextMenus } from "./menus";
import {
  getSiteAccessForActiveTab,
  getSiteAccessForTab,
  injectActiveTab,
  injectContentScriptForTab,
  isUrlEnabled,
  migrateLegacySiteAccess,
  setOriginEnabled
} from "./site-access";
import { assertLlmProviderAuthorized } from "./provider-access";
import { createLlmProvider } from "./llm-provider";
import { captureVisibleSenderTab, recognizeScreenshot, setupScreenshotCommand } from "./screenshot";
import { setupOnboarding } from "./onboarding";
import { inferImageInputCapability } from "./model-capabilities";

type RuntimeMessage =
  | ExplainRequest
  | FollowUpRequest
  | DetectTermsRequest
  | GetCachedTermsRequest
  | AddCachedTermsRequest
  | IgnoreTermRequest
  | GetSiteAccessRequest
  | SetSiteAccessRequest
  | InjectActiveTabRequest
  | TestLlmProviderRequest
  | CaptureVisibleTabRequest
  | RecognizeScreenshotRequest;

interface CacheContextMessage {
  url?: string;
  pageFingerprint?: string;
}

setupContextMenus();
setupDynamicInjection();
setupScreenshotCommand();
setupOnboarding();

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "TERMPOP_GET_SITE_ACCESS") {
    (sender.tab ? getSiteAccessForTab(sender.tab) : getSiteAccessForActiveTab())
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

  if (message.type === "TERMPOP_TEST_LLM_PROVIDER") {
    assertLlmProviderAuthorized(message.settings)
      .then(() => createLlmProvider(message.settings).test(message.settings))
      .then(() => sendResponse({ ok: true } satisfies TestLlmProviderResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies TestLlmProviderResponse));
    return true;
  }

  if (message.type === "TERMPOP_CAPTURE_VISIBLE_TAB") {
    ensureSenderCanUsePageServices(sender)
      .then(() => captureVisibleSenderTab(sender))
      .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies CaptureVisibleTabResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies CaptureVisibleTabResponse));
    return true;
  }

  if (message.type === "TERMPOP_RECOGNIZE_SCREENSHOT") {
    ensureSenderCanUsePageServices(sender)
      .then(() => recognizeScreenshot(message))
      .then((recognition) => sendResponse({ ok: true, recognition } satisfies RecognizeScreenshotResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies RecognizeScreenshotResponse));
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

  if (message.type === "TERMPOP_IGNORE_TERM") {
    ensureSenderCanUsePageServices(sender)
      .then(async () => {
        if (!message.term.trim()) {
          throw new Error("A term is required.");
        }
        await addIgnoredTerm(message.term);
      })
      .then(() => sendResponse({ ok: true } satisfies IgnoreTermResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies IgnoreTermResponse));
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

  if (message.type === "TERMPOP_FOLLOW_UP") {
    ensureSenderCanUsePageServices(sender)
      .then(() => {
        if (!consumeRateAllowance(sender, "explain")) {
          throw new Error("TermPop rate limit reached; try again shortly.");
        }
        if (!message.question.trim()) {
          throw new Error("A follow-up question is required.");
        }
      })
      .then(getSettings)
      .then((settings) => {
        const screenshotMode = settings.llm.screenshotRecognitionMode;
        const useScreenshotContext = settings.llm.screenshotRecognitionEnabled
          && (screenshotMode === "multimodal" || (screenshotMode === "auto" && inferImageInputCapability(settings.llm) === "supported"))
          && Boolean(message.termImageDataUrl && message.contextImageDataUrl);
        return followUp(
          message.term,
          message.context,
          message.explanation,
          message.history,
          message.question,
          useScreenshotContext
            ? { termImageDataUrl: message.termImageDataUrl!, contextImageDataUrl: message.contextImageDataUrl! }
            : undefined,
          settings.llm
        );
      })
      .then((answer) => sendResponse({ ok: true, answer } satisfies FollowUpResponse))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) } satisfies FollowUpResponse));
    return true;
  }

  return false;
});

const FOLLOW_UP_STREAM_PORT = "termpop-follow-up";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== FOLLOW_UP_STREAM_PORT) {
    return;
  }

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort(new Error("Follow-up stream disconnected.")));
  port.onMessage.addListener((message: unknown) => {
    if (!isFollowUpStreamStart(message)) {
      return;
    }
    void handleFollowUpStream(port, message, controller.signal);
  });
});

async function handleFollowUpStream(port: chrome.runtime.Port, message: FollowUpStreamStart, signal: AbortSignal): Promise<void> {
  const post = (payload: FollowUpStreamDone | FollowUpStreamError | { type: "TERMPOP_FOLLOW_UP_DELTA"; requestId: string; channel: "answer" | "thinking"; delta: string }): void => {
    if (!signal.aborted) {
      port.postMessage(payload);
    }
  };

  try {
    await ensureSenderCanUsePageServices(port.sender ?? {});
    if (!consumeRateAllowance(port.sender ?? {}, "explain")) {
      throw new Error("TermPop rate limit reached; try again shortly.");
    }
    if (!message.question.trim()) {
      throw new Error("A follow-up question is required.");
    }

    const settings = await getSettings();
    const screenshotMode = settings.llm.screenshotRecognitionMode;
    const useScreenshotContext = settings.llm.screenshotRecognitionEnabled
      && (screenshotMode === "multimodal" || (screenshotMode === "auto" && inferImageInputCapability(settings.llm) === "supported"))
      && Boolean(message.termImageDataUrl && message.contextImageDataUrl);
    const result = await followUpStream(
      message.term,
      message.context,
      message.explanation,
      message.history,
      message.question,
      useScreenshotContext
        ? { termImageDataUrl: message.termImageDataUrl!, contextImageDataUrl: message.contextImageDataUrl! }
        : undefined,
      settings.llm,
      {
        onAnswerDelta: (delta) => post({ type: "TERMPOP_FOLLOW_UP_DELTA", requestId: message.requestId, channel: "answer", delta }),
        onThinkingDelta: (delta) => post({ type: "TERMPOP_FOLLOW_UP_DELTA", requestId: message.requestId, channel: "thinking", delta })
      },
      signal
    );
    post({ type: "TERMPOP_FOLLOW_UP_DONE", requestId: message.requestId, result });
  } catch (error) {
    if (!signal.aborted) {
      post({ type: "TERMPOP_FOLLOW_UP_ERROR", requestId: message.requestId, error: errorMessage(error) });
    }
  }
}

function isFollowUpStreamStart(message: unknown): message is FollowUpStreamStart {
  return Boolean(
    message
    && typeof message === "object"
    && (message as { type?: unknown }).type === "TERMPOP_FOLLOW_UP_STREAM"
    && typeof (message as { requestId?: unknown }).requestId === "string"
  );
}

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
  void migrateLegacySiteAccess().then(reconcileOpenTabs);

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

  chrome.permissions.onAdded.addListener((permissions) => {
    if (!containsRelevantHostPermission(permissions.origins)) {
      return;
    }
    void migrateLegacySiteAccess().then(reconcileOpenTabs);
  });

  chrome.permissions.onRemoved.addListener((permissions) => {
    if (containsRelevantHostPermission(permissions.origins)) {
      void reconcileOpenTabs();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[BLOCKED_SITES_STORAGE_KEY]) {
      void reconcileOpenTabs();
    }
  });
}

async function reconcileOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) {
      return;
    }
    if (await isUrlEnabled(tab.url)) {
      await injectContentScriptForTab(tab.id, tab.url);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TERMPOP_DISABLE_SITE" } satisfies DisableSiteRequest);
    } catch {
      // Tabs without a TermPop content script do not need cleanup.
    }
  }));
}

function containsRelevantHostPermission(origins: string[] | undefined): boolean {
  return Boolean(origins?.some((origin) =>
    origin === FILE_ORIGIN_PATTERN || ALL_SITES_ORIGIN_PATTERNS.includes(origin as typeof ALL_SITES_ORIGIN_PATTERNS[number])
  ));
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
