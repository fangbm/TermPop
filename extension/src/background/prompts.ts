import type { Explanation, ExplanationLanguage, FollowUpTurn } from "../shared/types";
import { languageInstruction } from "./utils";

export function buildTermExtractionSystemPrompt(language: ExplanationLanguage): string {
  return [
    languageInstruction(language),
    "You extract vocabulary that would benefit from explanation.",
    "Do not explain, reason, analyze, or restate the task.",
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

export function buildExplanationSystemPrompt(language: ExplanationLanguage, includeUsageExample: boolean): string {
  return [
    languageInstruction(language),
    "You explain vocabulary for readers.",
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

export function buildScreenshotRecognitionSystemPrompt(language: ExplanationLanguage): string {
  return [
    languageInstruction(language),
    "You identify and explain one vocabulary term from screenshots for a reading assistant.",
    "Use the nearby context to choose the meaning that best fits what the user is reading.",
    "Do not describe the images.",
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

export function buildFollowUpSystemPrompt(language: ExplanationLanguage): string {
  return [
    languageInstruction(language),
    "You answer concise follow-up questions about a vocabulary explanation.",
    "Use the supplied reading context and earlier answer. Do not invent information.",
    "Reply with plain text only, without markdown headings or JSON."
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
