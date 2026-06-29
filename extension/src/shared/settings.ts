import type { ExtensionSettings, LlmSettings, TermPopMode } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  mode: "hover",
  llm: {
    provider: "mock",
    apiKey: "",
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    language: "auto",
    includeUsageExample: false,
    maxConcurrency: 5,
    temperature: 0.2,
    maxTokens: 450
  }
};

const SETTINGS_KEY = "termpop.settings";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const partial = stored[SETTINGS_KEY] as (Partial<ExtensionSettings> & { mode?: string }) | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    mode: normalizeMode(partial?.mode),
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...partial?.llm
    }
  };
}

function normalizeMode(mode: string | undefined): TermPopMode {
  if (mode === "selection" || mode === "hybrid" || mode === "hover") {
    return mode;
  }
  if (mode === "auto") {
    return "hover";
  }
  return DEFAULT_SETTINGS.mode;
}

export async function setMode(mode: TermPopMode): Promise<void> {
  const settings = await getSettings();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      mode
    }
  });
}

export async function setLlmSettings(llm: LlmSettings): Promise<void> {
  const settings = await getSettings();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      llm
    }
  });
}
