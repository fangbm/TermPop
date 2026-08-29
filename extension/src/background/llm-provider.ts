import type { Explanation, FollowUpStreamResult, FollowUpTurn, LlmSettings, ScreenshotRecognition } from "../shared/types";
import { parseExplanation } from "./explanation-parsing";
import { runWithLlmConcurrency } from "./llm-queue";
import {
  buildExplanationPrompt,
  buildExplanationSystemPrompt,
  buildFollowUpPrompt,
  buildFollowUpSystemPrompt,
  buildScreenshotRecognitionPrompt,
  buildScreenshotRecognitionSystemPrompt
} from "./prompts";
import { defaultBaseUrl, normalizeBaseUrl, sanitizeForLog } from "./utils";
import { parseScreenshotRecognition, splitImageDataUrl } from "./vision";
import { readSsePayloads } from "./streaming";

export interface TermPopLlmProvider {
  detectTerms(prompt: string, system: string, settings: LlmSettings, timeoutMs: number): Promise<string>;
  explain(term: string, context: string | undefined, settings: LlmSettings, selection?: boolean): Promise<Explanation>;
  followUp(term: string, context: string | undefined, explanation: Explanation, history: FollowUpTurn[], question: string, images: ScreenshotImages | undefined, settings: LlmSettings): Promise<string>;
  followUpStream(term: string, context: string | undefined, explanation: Explanation, history: FollowUpTurn[], question: string, images: ScreenshotImages | undefined, settings: LlmSettings, callbacks: FollowUpStreamCallbacks, signal?: AbortSignal): Promise<FollowUpStreamResult>;
  recognizeSelection(termImageDataUrl: string, contextImageDataUrl: string, settings: LlmSettings): Promise<ScreenshotRecognition>;
  test(settings: LlmSettings): Promise<void>;
}

export interface FollowUpStreamCallbacks {
  onAnswerDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
}

export interface ScreenshotImages {
  termImageDataUrl: string;
  contextImageDataUrl: string;
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
  explain(term, context, settings, selection = false) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchOpenAiCompatibleExplanation(term, context, settings, selection, signal)
    );
  },
  followUp(term, context, explanation, history, question, images, settings) {
    return this.followUpStream(term, context, explanation, history, question, images, settings, noopFollowUpCallbacks).then((result) => result.answer);
  },
  followUpStream(term, context, explanation, history, question, images, settings, callbacks, signal) {
    return runWithLlmConcurrency(settings, { priority: "explanation", signal }, (queueSignal) =>
      fetchOpenAiCompatibleFollowUpStream(term, context, explanation, history, question, images, settings, callbacks, queueSignal)
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
  explain(term, context, settings, selection = false) {
    return runWithLlmConcurrency(settings, { priority: "explanation" }, (signal) =>
      fetchAnthropicExplanation(term, context, settings, selection, signal)
    );
  },
  followUp(term, context, explanation, history, question, images, settings) {
    return this.followUpStream(term, context, explanation, history, question, images, settings, noopFollowUpCallbacks).then((result) => result.answer);
  },
  followUpStream(term, context, explanation, history, question, images, settings, callbacks, signal) {
    return runWithLlmConcurrency(settings, { priority: "explanation", signal }, (queueSignal) =>
      fetchAnthropicFollowUpStream(term, context, explanation, history, question, images, settings, callbacks, queueSignal)
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

const noopFollowUpCallbacks: FollowUpStreamCallbacks = {
  onAnswerDelta: () => undefined,
  onThinkingDelta: () => undefined
};

async function fetchOpenAiCompatibleFollowUpStream(
  term: string,
  context: string | undefined,
  explanation: Explanation,
  history: FollowUpTurn[],
  question: string,
  images: ScreenshotImages | undefined,
  settings: LlmSettings,
  callbacks: FollowUpStreamCallbacks,
  signal?: AbortSignal
): Promise<FollowUpStreamResult> {
  const prompt = buildFollowUpPrompt(term, context, explanation, history, question);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (images) {
    content.push(
      { type: "text", text: "The reader selected this exact area from the original screenshot:" },
      { type: "image_url", image_url: { url: images.termImageDataUrl, detail: "high" } },
      { type: "text", text: "Nearby reading context from the original screenshot:" },
      { type: "image_url", image_url: { url: images.contextImageDataUrl, detail: "high" } }
    );
  }
  const baseUrl = normalizeBaseUrl(settings.baseUrl || defaultBaseUrl(settings.provider));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model.trim(),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream: true,
      messages: [
        { role: "system", content: buildFollowUpSystemPrompt(settings.language, settings.promptOverrides?.followUp) },
        { role: "user", content }
      ]
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }
  const accumulator = createFollowUpAccumulator(callbacks);
  if (response.headers.get("content-type")?.toLocaleLowerCase().includes("text/event-stream")) {
    await readSsePayloads(response, (payload) => {
      const delta = extractOpenAiCompatibleStreamDelta(payload);
      accumulator.answer(delta.answer);
      accumulator.thinking(delta.thinking);
    });
  } else {
    accumulator.answer(extractOpenAiCompatibleAnswerText(await response.json()));
  }
  return accumulator.finish();
}

async function fetchAnthropicFollowUpStream(
  term: string,
  context: string | undefined,
  explanation: Explanation,
  history: FollowUpTurn[],
  question: string,
  images: ScreenshotImages | undefined,
  settings: LlmSettings,
  callbacks: FollowUpStreamCallbacks,
  signal?: AbortSignal
): Promise<FollowUpStreamResult> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: buildFollowUpPrompt(term, context, explanation, history, question) }];
  if (images) {
    const termImage = splitImageDataUrl(images.termImageDataUrl);
    const contextImage = splitImageDataUrl(images.contextImageDataUrl);
    content.push(
      { type: "text", text: "The reader selected this exact area from the original screenshot:" },
      { type: "image", source: { type: "base64", media_type: termImage.mediaType, data: termImage.data } },
      { type: "text", text: "Nearby reading context from the original screenshot:" },
      { type: "image", source: { type: "base64", media_type: contextImage.mediaType, data: contextImage.data } }
    );
  }
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
      model: settings.model.trim(),
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      stream: true,
      system: buildFollowUpSystemPrompt(settings.language, settings.promptOverrides?.followUp),
      messages: [{ role: "user", content }]
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(await formatProviderError(response));
  }
  const accumulator = createFollowUpAccumulator(callbacks);
  if (response.headers.get("content-type")?.toLocaleLowerCase().includes("text/event-stream")) {
    await readSsePayloads(response, (payload) => {
      const delta = extractAnthropicStreamDelta(payload);
      accumulator.answer(delta.answer);
      accumulator.thinking(delta.thinking);
    });
  } else {
    const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    accumulator.answer(payload.content?.find((part) => part.type === "text")?.text ?? "");
  }
  return accumulator.finish();
}

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
      model: settings.model.trim(),
      temperature: Math.min(settings.temperature, 0.1),
      max_tokens: Math.max(128, Math.min(settings.maxTokens, 450)),
      messages: [
        {
          role: "system",
          content: buildScreenshotRecognitionSystemPrompt(settings.language, settings.promptOverrides?.screenshot)
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
      model: settings.model.trim(),
      max_tokens: Math.max(128, Math.min(settings.maxTokens, 450)),
      temperature: Math.min(settings.temperature, 0.1),
      system: buildScreenshotRecognitionSystemPrompt(settings.language, settings.promptOverrides?.screenshot),
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
  selection: boolean,
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
      model: settings.model.trim(),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      messages: [
        {
          role: "system",
          content: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample, settings.promptOverrides?.explanation, selection)
        },
        {
          role: "user",
          content: buildExplanationPrompt(term, context, settings.language, settings.includeUsageExample, selection)
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
  selection: boolean,
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
      model: settings.model.trim(),
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      system: buildExplanationSystemPrompt(settings.language, settings.includeUsageExample, settings.promptOverrides?.explanation, selection),
      messages: [
        {
          role: "user",
          content: buildExplanationPrompt(term, context, settings.language, settings.includeUsageExample, selection)
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
      model: settings.model.trim(),
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
      model: settings.model.trim(),
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

function createFollowUpAccumulator(callbacks: FollowUpStreamCallbacks): {
  answer: (delta: string) => void;
  thinking: (delta: string) => void;
  finish: () => FollowUpStreamResult;
} {
  const startedAt = Date.now();
  let answer = "";
  let thinking = "";
  let thinkingStartedAt: number | undefined;
  let thinkingFinishedAt: number | undefined;

  const append = (current: string, delta: string, limit: number): string => {
    if (!delta || current.length >= limit) {
      return current;
    }
    return `${current}${delta.slice(0, Math.max(0, limit - current.length))}`;
  };

  return {
    answer(delta) {
      const next = append(answer, delta, 2_000);
      const emitted = next.slice(answer.length);
      if (!emitted) {
        return;
      }
      if (thinking && thinkingFinishedAt === undefined) {
        thinkingFinishedAt = Date.now();
      }
      answer = next;
      callbacks.onAnswerDelta(emitted);
    },
    thinking(delta) {
      const next = append(thinking, delta, 4_000);
      const emitted = next.slice(thinking.length);
      if (!emitted) {
        return;
      }
      thinkingStartedAt ??= Date.now();
      thinking = next;
      callbacks.onThinkingDelta(emitted);
    },
    finish() {
      // Some OpenAI-compatible endpoints return the answer in reasoning only.
      // Preserve compatibility while avoiding a duplicate thinking panel.
      if (!answer.trim() && thinking.trim()) {
        return { answer: thinking.trim().slice(0, 2_000), elapsedMs: Date.now() - startedAt };
      }
      if (!answer.trim()) {
        throw new Error("LLM response did not include text content.");
      }
      return {
        answer: answer.trim(),
        thinking: thinking.trim() || undefined,
        thinkingDurationMs: thinkingStartedAt === undefined ? undefined : (thinkingFinishedAt ?? Date.now()) - thinkingStartedAt,
        elapsedMs: Date.now() - startedAt
      };
    }
  };
}

function extractOpenAiCompatibleStreamDelta(payload: unknown): { answer: string; thinking: string } {
  const choice = (payload as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0];
  const delta = choice?.delta;
  return {
    answer: stringifyProviderDelta(delta?.content ?? delta?.text),
    thinking: stringifyProviderDelta(delta?.reasoning_content ?? delta?.reasoning ?? delta?.analysis)
  };
}

function extractAnthropicStreamDelta(payload: unknown): { answer: string; thinking: string } {
  const object = payload as { type?: string; delta?: Record<string, unknown> };
  if (object.type !== "content_block_delta") {
    return { answer: "", thinking: "" };
  }
  const delta = object.delta;
  const deltaType = delta?.type;
  return {
    answer: deltaType === "text_delta" ? stringifyProviderDelta(delta?.text) : "",
    thinking: deltaType === "thinking_delta" ? stringifyProviderDelta(delta?.thinking) : ""
  };
}

function stringifyProviderDelta(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        const object = part as Record<string, unknown>;
        return stringifyProviderDelta(object.text ?? object.content);
      }
      return "";
    }).join("");
  }
  return "";
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
