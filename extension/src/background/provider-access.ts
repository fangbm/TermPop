import { providerOriginPatternFromBaseUrl } from "../shared/browser-utils";
import type { LlmSettings } from "../shared/types";
import { hasAllSitesAccess } from "./site-access";

export const LLM_NOT_CONFIGURED_ERROR = "LLM is not configured. Add an API key in TermPop settings.";

export async function assertLlmProviderAuthorized(settings: LlmSettings): Promise<void> {
  if (!settings.apiKey.trim()) {
    throw new Error(LLM_NOT_CONFIGURED_ERROR);
  }

  const originPattern = providerOriginPatternFromBaseUrl(settings.baseUrl);
  if (!originPattern) {
    throw new Error("The LLM Base URL must use an HTTP or HTTPS origin.");
  }

  if (!await hasAllSitesAccess()) {
    throw new Error("Enable TermPop on all websites before using an LLM provider.");
  }
}
