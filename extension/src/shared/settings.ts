import type { ExtensionSettings, LlmSettings, TermLensMode } from "./types";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  mode: "auto",
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

const SETTINGS_KEY = "termlens.settings";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const partial = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...partial?.llm
    }
  };
}

export async function setMode(mode: TermLensMode): Promise<void> {
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
