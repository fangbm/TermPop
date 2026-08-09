import type { Explanation, LlmSettings, ScreenshotRecognition } from "../shared/types";
import { extractJsonObject } from "./json";
import { runWithLlmConcurrency } from "./llm-queue";
import {
  buildExplanationPrompt,
  buildExplanationSystemPrompt,
  buildScreenshotRecognitionPrompt,
  buildScreenshotRecognitionSystemPrompt
} from "./prompts";
import { defaultBaseUrl, defaultModel, normalizeBaseUrl, sanitizeForLog } from "./utils";
import { parseScreenshotRecognition, splitImageDataUrl } from "./vision";

export interface TermPopLlmProvider {
  detectTerms(prompt: string, system: string, settings: LlmSettings, timeoutMs: number): Promise<string>;
  explain(term: string, context: string | undefined, settings: LlmSettings): Promise<Explanation>;
  recognizeSelection(termImageDataUrl: string, contextImageDataUrl: string, settings: LlmSettings): Promise<ScreenshotRecognition>;
  test(settings: LlmSettings): Promise<void>;
}

export function createLlmProvider(settings: LlmSettings): TermPopLlmProvider {
  return settings.provider === "anthropic" ? anthropicProvider : openAiCompatibleProvider;
}

const openAiCompatibleProvider: TermPopLlmProvider = {
  detectTerms(prompt, system, settings, timeoutMs) {
    return runWithLlmConcurrency(settings, { priority: "detection", timeoutMs }, (signal) =>
      fetchOpenAiCompatibleDetectionText(settings, system, prompt, signal)
    );
  },
  explain(term, context, settings) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchOpenAiCompatibleExplanation(term, context, settings, signal)
    );
  },
  recognizeSelection(termImageDataUrl, contextImageDataUrl, settings) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchOpenAiCompatibleScreenshotRecognition(termImageDataUrl, contextImageDataUrl, settings, signal)
    );
  },
  async test(settings) {
    await this.explain("TermPop", undefined, settings);
  }
};

const anthropicProvider: TermPopLlmProvider = {
  detectTerms(prompt, system, settings, timeoutMs) {
    return runWithLlmConcurrency(settings, { priority: "detection", timeoutMs }, (signal) =>
      fetchAnthropicText(settings, `${system} ${prompt}`, signal)
    );
  },
  explain(term, context, settings) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchAnthropicExplanation(term, context, settings, signal)
    );
  },
  recognizeSelection(termImageDataUrl, contextImageDataUrl, settings) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchAnthropicScreenshotRecognition(termImageDataUrl, contextImageDataUrl, settings, signal)
    );
  },
  async test(settings) {
    await this.explain("TermPop", undefined, settings);
  }
};

async function fetchOpenAiCompatibleScreenshotRecognition(
  termImageDataUrl: string,
  contextImageDataUrl: string,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<ScreenshotRecognition> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.1),
      max_tokens: Math.max(128, Math.min(settings.maxTokens, 450)),
      messages: [
        {
          role: "system",
          content: buildScreenshotRecognitionSystemPrompt(settings.language)
        },
        {
          role: "user",
          content: [
            { type: "text", text: buildScreenshotRecognitionPrompt(settings.language, settings.includeUsageExample) },
            { type: "text", text: "Nearby context image:" },
            { type: "image_url", image_url: { url: contextImageDataUrl, detail: "high" } },
            { type: "text", text: "Exact user-selected area:" },
            { type: "image_url", image_url: { url: termImageDataUrl, detail: "high" } }
          ]
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = await response.json();
  return parseScreenshotRecognition(extractOpenAiCompatibleAnswerText(payload), settings.includeUsageExample);
}

async function fetchAnthropicScreenshotRecognition(
  termImageDataUrl: string,
  contextImageDataUrl: string,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<ScreenshotRecognition> {
  const termImage = splitImageDataUrl(termImageDataUrl);
  const contextImage = splitImageDataUrl(contextImageDataUrl);
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      max_tokens: Math.max(128, Math.min(settings.maxTokens, 450)),
      temperature: Math.min(settings.temperature, 0.1),
      system: buildScreenshotRecognitionSystemPrompt(settings.language),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildScreenshotRecognitionPrompt(settings.language, settings.includeUsageExample) },
            { type: "text", text: "Nearby context image:" },
            { type: "image", source: { type: "base64", media_type: contextImage.mediaType, data: contextImage.data } },
            { type: "text", text: "Exact user-selected area:" },
            { type: "image", source: { type: "base64", media_type: termImage.mediaType, data: termImage.data } }
          ]
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find((part) => part.type === "text")?.text;
  if (!content) {
    throw new Error("LLM response did not include text content.");
  }
  return parseScreenshotRecognition(content, settings.includeUsageExample);
}

async function fetchOpenAiCompatibleExplanation(
  term: string,
  context: string | undefined,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<Explanation> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      messages: [
        {
          role: "system",
          content: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample)
        },
        {
          role: "user",
          content: buildExplanationPrompt(term, context, settings.language, settings.includeUsageExample)
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = await response.json();
  const content = extractOpenAiCompatibleText(payload);
  return parseExplanation(content, term, settings.includeUsageExample);
}

async function fetchAnthropicExplanation(
  term: string,
  context: string | undefined,
  settings: LlmSettings,
  signal?: AbortSignal
): Promise<Explanation> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      system: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample),
      messages: [
        {
          role: "user",
          content: buildExplanationPrompt(term, context, settings.language, settings.includeUsageExample)
        }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find((part) => part.type === "text")?.text;
  if (!content) {
    throw new Error("LLM response did not include text content.");
  }

  return parseExplanation(content, term, settings.includeUsageExample);
}

async function fetchOpenAiCompatibleDetectionText(settings: LlmSettings, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.1),
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = await response.json();
  return extractOpenAiCompatibleAnswerText(payload);
}

async function fetchAnthropicText(settings: LlmSettings, prompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.model || defaultModel(settings.provider),
      temperature: Math.min(settings.temperature, 0.1),
      system: "Return only valid JSON.",
      messages: [{ role: "user", content: prompt }]
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find((part) => part.type === "text")?.text;
  if (!content) {
    throw new Error("LLM response did not include text content.");
  }
  return content;
}

function parseExplanation(content: string, fallbackTerm: string, includeUsageExample: boolean): Explanation {
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as Partial<Explanation>;
    return {
      term: typeof parsed.term === "string" && parsed.term.trim() ? parsed.term.trim() : fallbackTerm,
      definition: typeof parsed.definition === "string" ? parsed.definition.trim() : cleanupPlainTextExplanation(content, fallbackTerm),
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : "LLM explanation",
      related_terms: Array.isArray(parsed.related_terms)
        ? parsed.related_terms.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 6)
        : [],
      usage_example: includeUsageExample && typeof parsed.usage_example === "string" ? parsed.usage_example.trim() : null,
      source_url: typeof parsed.source_url === "string" ? parsed.source_url : null,
      provider_status: "llm"
    };
  } catch {
    return {
      term: fallbackTerm,
      definition: cleanupPlainTextExplanation(content, fallbackTerm),
      category: "LLM explanation",
      related_terms: [],
      usage_example: null,
      source_url: null,
      provider_status: "llm"
    };
  }
}

function extractOpenAiCompatibleText(payload: unknown): string {
  const object = payload as {
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };
  const first = object.choices?.[0];
  const content = first?.message?.content ?? first?.text;
  const text = stringifyProviderText(content);
  if (!text) {
    throw new Error("LLM response did not include message content.");
  }
  return text;
}

function extractOpenAiCompatibleAnswerText(payload: unknown): string {
  const object = payload as {
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown };
      text?: unknown;
    }>;
  };
  const first = object.choices?.[0];
  const finalText = stringifyProviderText(first?.message?.content ?? first?.text);
  if (finalText) {
    return finalText;
  }
  const reasoningText = stringifyProviderText(first?.message?.reasoning_content);
  if (reasoningText) {
    return reasoningText;
  }
  throw new Error("LLM response did not include usable text.");
}

function stringifyProviderText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        const object = part as Record<string, unknown>;
        return stringifyProviderText(object.text ?? object.content);
      }
      return "";
    }).join("").trim();
  }
  return "";
}

function cleanupPlainTextExplanation(content: string, term: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) {
    return `${term} is a term TermPop detected in the surrounding context.`;
  }
  return compact.slice(0, 500);
}

async function formatProviderError(response: Response): Promise<string> {
  const fallback = providerErrorFallback(response);
  try {
    const text = await response.text();
    if (!text.trim()) {
      return fallback;
    }
    return `${fallback} ${sanitizeForLog(text.replace(/\s+/g, " ").trim(), 300)}`;
  } catch {
    return fallback;
  }
}

function providerErrorFallback(response: Response): string {
  const locale = uiLocale();
  if (response.status === 401) {
    return providerErrorCopy[locale].unauthorized;
  }
  if (response.status === 403) {
    return providerErrorCopy[locale].forbidden;
  }
  if (response.status === 429) {
    return providerErrorCopy[locale].rateLimited;
  }
  return `${providerErrorCopy[locale].failed}: ${response.status} ${response.statusText}`;
}

const providerErrorCopy = {
  zh: {
    unauthorized: "LLM API 授权失败，请检查插件设置里的 API Key、Base URL 和模型。",
    forbidden: "LLM API 拒绝访问，请检查 API Key 权限或账号状态。",
    rateLimited: "LLM API 请求过于频繁，请稍后再试。",
    failed: "LLM API 请求失败"
  },
  en: {
    unauthorized: "LLM API authorization failed. Check the API Key, Base URL, and model in extension settings.",
    forbidden: "LLM API access was denied. Check the API Key permissions or account status.",
    rateLimited: "LLM API rate limit reached. Please try again later.",
    failed: "LLM API request failed"
  }
} as const;

function uiLocale(): "zh" | "en" {
  const language = chrome.i18n?.getUILanguage?.() ?? "en";
  return language.toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
}
