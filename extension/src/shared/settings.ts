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
    maxTokens: 450,
    advancedVisible: false,
    debugLogging: false
  },
  dictionary: {
    base: [],
    domain: [],
    user: []
  }
};

// General settings (mode, dictionary) are read by content scripts on every
// enabled page, so they live in their own storage key. LLM settings contain
// the API key and are only read by extension pages (service worker, popup).
const SETTINGS_KEY = "termpop.settings";
const LLM_SETTINGS_KEY = "termpop.llmSettings";

type StoredGeneralSettings = Partial<Pick<ExtensionSettings, "dictionary">> & {
  mode?: string;
  // Legacy key used before LLM settings were split into their own storage key.
  llm?: Partial<LlmSettings>;
};

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, LLM_SETTINGS_KEY]);
  const general = stored[SETTINGS_KEY] as StoredGeneralSettings | undefined;
  let llm = stored[LLM_SETTINGS_KEY] as Partial<LlmSettings> | undefined;

  if (!llm && general?.llm) {
    // Migrate LLM settings out of the combined key written by older versions.
    llm = general.llm;
    const { llm: _legacyLlm, ...rest } = general;
    await chrome.storage.local.set({
      [SETTINGS_KEY]: rest,
      [LLM_SETTINGS_KEY]: llm
    });
  }

  return {
    ...DEFAULT_SETTINGS,
    mode: normalizeMode(general?.mode),
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...llm
    },
    dictionary: {
      ...DEFAULT_SETTINGS.dictionary,
      ...general?.dictionary
    }
  };
}

/**
 * Settings available to content scripts. Intentionally excludes LLM settings
 * so the API key is never loaded into per-page script contexts.
 */
export async function getContentSettings(): Promise<Pick<ExtensionSettings, "mode">> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const general = stored[SETTINGS_KEY] as StoredGeneralSettings | undefined;
  return { mode: normalizeMode(general?.mode) };
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
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const general = (stored[SETTINGS_KEY] ?? {}) as StoredGeneralSettings;
  const { llm: _legacyLlm, ...rest } = general;
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...rest,
      mode
    }
  });
}

export async function setLlmSettings(llm: LlmSettings): Promise<void> {
  await chrome.storage.local.set({
    [LLM_SETTINGS_KEY]: llm
  });
}
