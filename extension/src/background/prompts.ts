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

export function buildExplanationSystemPrompt(language: ExplanationLanguage, includeUsageExample: boolean, override?: string): string {
  return [
    languageInstruction(language),
    promptInstruction("explanation", override),
    "Return only valid JSON. Do not include markdown fences.",
    explanationJsonShapeInstruction(includeUsageExample)
  ].join(" ");
}

export function buildExplanationPrompt(term: string, context: string | undefined, language: ExplanationLanguage, includeUsageExample: boolean): string {
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

function usageExamplePromptLine(includeUsageExample: boolean): string {
  return includeUsageExample
    ? "Include one short usage example that fits the context."
    : "Do not generate a usage example; set usage_example to null.";
}
