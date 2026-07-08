import type { ExplanationLanguage } from "../shared/types";
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
