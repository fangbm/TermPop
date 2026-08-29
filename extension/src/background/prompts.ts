import type { Explanation, ExplanationLanguage, FollowUpTurn, PromptTemplateKind } from "../shared/types";
import { languageInstruction } from "./utils.ts";

export const DEFAULT_PROMPT_INSTRUCTIONS: Record<PromptTemplateKind, string> = {
  detection: "You extract vocabulary that would benefit from explanation. Do not explain, reason, analyze, or restate the task.",
  explanation: "You explain vocabulary for readers.",
  screenshot: "You identify and explain one vocabulary term from screenshots for a reading assistant. Use the nearby context to choose the meaning that best fits what the user is reading. Do not describe the images.",
  followUp: "You answer concise follow-up questions about a vocabulary explanation. Use the supplied reading context and earlier answer. Do not invent information. Reply with plain text only, without markdown headings or JSON."
};

export function promptInstruction(kind: PromptTemplateKind, override?: string): string {
  return override?.trim() || DEFAULT_PROMPT_INSTRUCTIONS[kind];
}

export function buildTermExtractionSystemPrompt(language: ExplanationLanguage, override?: string): string {
  return [
    languageInstruction(language),
    promptInstruction("detection", override),
    "Your entire response must be exactly one minified JSON object and nothing else."
  ].join(" ");
}

export function buildTermExtractionPrompt(text: string, language: ExplanationLanguage, chunkNumber: number, totalChunks: number): string {
  return [
    languageInstruction(language),
    `From text segment ${chunkNumber}/${totalChunks} below, identify terms that a reader may want explained in context.`,
    "Prefer domain-specific nouns, file names, commands, APIs, acronyms, product names, framework names, and proper nouns.",
    "Do not include ordinary function words, full sentences, generic academic words, or common task nouns.",
    "Reject simple context words such as task, tasks, data, model, models, result, results, best, English, French, and German unless they are part of a longer domain-specific phrase.",
    "Each term must be an exact substring copied from the text with the same casing and punctuation.",
    "Return JSON only in this shape:",
    "{\"terms\":[{\"term\":\"exact text\",\"term_type\":\"Tech|Brand|Person|Place|Acronym|Custom\",\"confidence\":0.0}]}",
    "",
    `Text: ${text}`
  ].join("\n");
}

export function buildExplanationSystemPrompt(
  language: ExplanationLanguage,
  includeUsageExample: boolean,
  override?: string,
  selection = false
): string {
  return [
    languageInstruction(language),
    promptInstruction("explanation", override),
    "Return only valid JSON. Do not include markdown fences.",
    selection ? selectionExplanationJsonShapeInstruction(includeUsageExample) : explanationJsonShapeInstruction(includeUsageExample)
  ].join(" ");
}

export function buildExplanationPrompt(
  term: string,
  context: string | undefined,
  language: ExplanationLanguage,
  includeUsageExample: boolean,
  selection = false
): string {
  if (selection) {
    return buildSelectedContentExplanationPrompt(term, context, language, includeUsageExample);
  }
  return [
    languageInstruction(language),
    `Term: ${term}`,
    `Context: ${context?.trim() || "(no context provided)"}`,
    "Explain the term in the most context-appropriate meaning.",
    "Use 1-2 concise sentences for definition.",
    usageExamplePromptLine(includeUsageExample),
    "Return valid JSON only."
  ].filter(Boolean).join("\n");
}

function buildSelectedContentExplanationPrompt(
  selectedText: string,
  context: string | undefined,
  language: ExplanationLanguage,
  includeUsageExample: boolean
): string {
  return [
    languageInstruction(language),
    "The reader explicitly selected the content below. First classify it silently as exactly one of: term, code, command, error, config, or text.",
    "Use code for source snippets, command for shell or CLI instructions, error for errors or stack traces, config for configuration or structured settings, text for a normal paragraph, and term for a short concept or phrase.",
    "Give a concise, context-aware explanation. For code include purpose, inputs/outputs or side effects, and any pitfall. For commands include what it does, impact, and safety notes. For errors include likely cause and concrete next checks. For config include field meaning and effect.",
    "For text, treat the selection as a passage to be read, not a term list. Put a one- or two-sentence plain-language summary in definition. Use sections only for the key claims, reasoning or relationships, and necessary context. Do not extract, list, or explain individual keywords: automatic highlighting handles individual terms separately.",
    "Use at most four short sections. Do not invent commands, configuration values, or runtime behavior that are not supported by the selected content or context.",
    includeUsageExample
      ? "Include one short usage example only when it clarifies a non-text selection. For kind text, always set usage_example to null and related_terms to []."
      : "Do not generate a usage example; set usage_example to null. For kind text, always set related_terms to [].",
    "Return valid JSON only.",
    `Selected content: ${selectedText}`,
    `Nearby context: ${context?.trim() || "(no context provided)"}`
  ].join("\n");
}

export function buildScreenshotRecognitionSystemPrompt(language: ExplanationLanguage, override?: string): string {
  return [
    languageInstruction(language),
    promptInstruction("screenshot", override),
    "Return exactly one minified JSON object and nothing else."
  ].join(" ");
}

export function buildScreenshotRecognitionPrompt(language: ExplanationLanguage, includeUsageExample: boolean): string {
  return [
    languageInstruction(language),
    "The first image shows nearby reading context. The second image is the exact area selected by the user.",
    "Identify the single word or short phrase the user most likely wants explained from the selected area.",
    "Preserve the visible casing and punctuation. Do not return a full sentence.",
    "Use the context image to transcribe a concise nearby sentence or phrase that disambiguates the term.",
    "Explain the term in 1-2 concise sentences using the meaning that best fits that context.",
    includeUsageExample
      ? "Include one short usage example that fits the context."
      : "Do not generate a usage example; set usage_example to null.",
    "If the selected area is ambiguous, choose the most central prominent term and lower confidence.",
    "Return JSON only in this shape:",
    "{\"term\":\"exact visible term\",\"context\":\"nearby context\",\"confidence\":0.0,\"definition\":\"context-appropriate explanation\",\"category\":\"concise category\",\"related_terms\":[\"term\"],\"usage_example\":null,\"source_url\":null}"
  ].join("\n");
}

export function buildFollowUpSystemPrompt(language: ExplanationLanguage, override?: string): string {
  return [
    languageInstruction(language),
    promptInstruction("followUp", override)
  ].join(" ");
}

export function buildFollowUpPrompt(
  term: string,
  context: string | undefined,
  explanation: Explanation,
  history: FollowUpTurn[],
  question: string
): string {
  const recentHistory = history.slice(-8).flatMap((turn) => [
    `Reader: ${turn.question}`,
    `Assistant: ${turn.answer}`
  ]);
  return [
    `Term: ${term}`,
    `Reading context: ${context?.trim() || "(no context provided)"}`,
    `Initial explanation: ${explanation.definition}`,
    ...recentHistory,
    `Reader: ${question.trim()}`,
    "Answer the reader's latest question in 1-3 concise sentences."
  ].join("\n");
}

export function buildReadingAssistSystemPrompt(language: ExplanationLanguage): string {
  return [
    languageInstruction(language),
    "You are a precise reading assistant.",
    "Return exactly one minified JSON object and nothing else."
  ].join(" ");
}

export function buildReadingSummaryPrompt(text: string): string {
  return [
    "Summarize the supplied visible page text without inventing facts.",
    "Return 2-5 concise core claims, 1-4 structural points, and 3-8 important terms.",
    "Return JSON only in this shape:",
    "{\"summary\":[\"claim\"],\"structure\":[\"section or relationship\"],\"terms\":[\"term\"]}",
    "",
    `Visible text: ${text}`
  ].join("\n");
}

export function buildBatchExplanationPrompt(text: string): string {
  return [
    "From the selected text, choose 3-8 domain-specific terms that are most useful to explain.",
    "Skip ordinary words and do not return terms that do not appear in the selected text.",
    "Explain each item in one concise, context-specific sentence.",
    "Return JSON only in this shape:",
    "{\"items\":[{\"term\":\"exact selected term\",\"explanation\":\"concise explanation\"}]}",
    "",
    `Selected text: ${text}`
  ].join("\n");
}

function explanationJsonShapeInstruction(includeUsageExample: boolean): string {
  return includeUsageExample
    ? "JSON shape: {\"term\":\"...\",\"definition\":\"...\",\"category\":\"...\",\"related_terms\":[\"...\"],\"usage_example\":\"...\",\"source_url\":null}"
    : "JSON shape: {\"term\":\"...\",\"definition\":\"...\",\"category\":\"...\",\"related_terms\":[\"...\"],\"usage_example\":null,\"source_url\":null}";
}

function selectionExplanationJsonShapeInstruction(includeUsageExample: boolean): string {
  const usageExample = includeUsageExample ? "\"usage_example\":\"...\"" : "\"usage_example\":null";
  return `JSON shape: {"term":"short title","kind":"term|code|command|error|config|text","definition":"concise overview","category":"concise category","sections":[{"label":"purpose","content":"concise detail"}],"related_terms":["..."],${usageExample},"source_url":null}. For kind text, definition must be a one- or two-sentence summary, sections must cover claims, reasoning, or context, related_terms must be [], and usage_example must be null.`;
}

function usageExamplePromptLine(includeUsageExample: boolean): string {
  return includeUsageExample
    ? "Include one short usage example that fits the context."
    : "Do not generate a usage example; set usage_example to null.";
}
