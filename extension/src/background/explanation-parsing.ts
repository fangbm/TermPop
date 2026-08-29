import type { Explanation, ExplanationKind, ExplanationSection } from "../shared/types.ts";
import { extractJsonObject } from "./json.ts";

export function parseExplanation(content: string, fallbackTerm: string, includeUsageExample: boolean): Explanation {
  const fallbackTitle = fallbackTerm.replace(/\s+/g, " ").trim().slice(0, 120);
  try {
    const parsed = JSON.parse(extractJsonObject(content)) as Partial<Explanation>;
    return {
      term: typeof parsed.term === "string" && parsed.term.trim() ? parsed.term.trim().slice(0, 120) : fallbackTitle,
      definition: typeof parsed.definition === "string" ? parsed.definition.trim() : cleanupPlainTextExplanation(content, fallbackTitle),
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : "LLM explanation",
      related_terms: Array.isArray(parsed.related_terms)
        ? parsed.related_terms.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 6)
        : [],
      kind: parseExplanationKind(parsed.kind),
      sections: parseExplanationSections(parsed.sections),
      usage_example: includeUsageExample && typeof parsed.usage_example === "string" ? parsed.usage_example.trim() : null,
      source_url: typeof parsed.source_url === "string" ? parsed.source_url : null,
      provider_status: "llm"
    };
  } catch {
    return {
      term: fallbackTitle,
      definition: cleanupPlainTextExplanation(content, fallbackTitle),
      category: "LLM explanation",
      related_terms: [],
      usage_example: null,
      source_url: null,
      provider_status: "llm"
    };
  }
}

function cleanupPlainTextExplanation(content: string, term: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) {
    return `${term} is a term TermPop detected in the surrounding context.`;
  }
  return compact.slice(0, 500);
}

function parseExplanationKind(value: unknown): ExplanationKind | undefined {
  return value === "term" || value === "code" || value === "command" || value === "error" || value === "config" || value === "text"
    ? value
    : undefined;
}

function parseExplanationSections(value: unknown): ExplanationSection[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sections = value.flatMap((item): ExplanationSection[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const section = item as { label?: unknown; content?: unknown };
    const label = typeof section.label === "string" ? section.label.trim() : "";
    const content = typeof section.content === "string" ? section.content.trim() : "";
    return label && content ? [{ label: label.slice(0, 80), content: content.slice(0, 700) }] : [];
  });
  return sections.slice(0, 4);
}
