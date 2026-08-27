import { extractJsonObject } from "./json.ts";
import type { ReadingAssistKind, ReadingAssistResult } from "../shared/types";

export function parseReadingAssistResult(kind: ReadingAssistKind, raw: string): ReadingAssistResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  if (kind === "summary") {
    const summary = textList(parsed.summary, 5);
    const structure = textList(parsed.structure, 4);
    const terms = textList(parsed.terms, 8);
    if (summary.length === 0 && structure.length === 0 && terms.length === 0) {
      throw new Error("The reading summary did not include usable content.");
    }
    return { summary, structure, terms };
  }

  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const term = String(item.term ?? "").trim();
      const explanation = String(item.explanation ?? "").trim();
      return term && explanation ? [{ term: term.slice(0, 100), explanation: explanation.slice(0, 500) }] : [];
    }).slice(0, 8)
    : [];
  if (items.length === 0) {
    throw new Error("The batch explanation did not include usable terms.");
  }
  return { items };
}

function textList(value: unknown, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, maxLength)
    : [];
}
