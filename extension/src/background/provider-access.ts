import { providerOriginPatternFromBaseUrl } from "../shared/browser-utils";
import type { LlmSettings } from "../shared/types";
import { hasAllSitesAccess } from "./site-access";

export async function assertLlmProviderAuthorized(settings: LlmSettings): Promise<void> {
  if (settings.provider === "mock" || !settings.apiKey.trim()) {
    return;
  }

  const originPattern = providerOriginPatternFromBaseUrl(settings.baseUrl);
  if (!originPattern) {
    throw new Error("The LLM Base URL must use an HTTP or HTTPS origin.");
  }

  if (!await hasAllSitesAccess()) {
    throw new Error("Enable TermPop on all websites before using an LLM provider.");
  }
}
