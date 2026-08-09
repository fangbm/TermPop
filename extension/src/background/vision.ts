import type { Explanation, ScreenshotRecognition } from "../shared/types";
import { extractJsonObject } from "./json.ts";

const MAX_SCREENSHOT_DATA_URL_LENGTH = 6_000_000;
const SCREENSHOT_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

export function parseScreenshotRecognition(content: string, includeUsageExample = false): ScreenshotRecognition {
  const parsed = JSON.parse(extractJsonObject(content)) as Partial<ScreenshotRecognition & Explanation>;
  const term = typeof parsed.term === "string"
    ? parsed.term.replace(/\s+/g, " ").trim().slice(0, 120)
    : "";
  if (!term) {
    throw new Error("The vision model did not identify a term in the selected area.");
  }
  const context = typeof parsed.context === "string"
    ? parsed.context.replace(/\s+/g, " ").trim().slice(0, 1600)
    : term;
  const definition = typeof parsed.definition === "string" ? parsed.definition.trim() : "";
  if (!definition) {
    throw new Error("The vision model identified a term but did not explain it.");
  }
  const confidence = Number(parsed.confidence);
  const explanation: Explanation = {
    term,
    definition,
    category: typeof parsed.category === "string" && parsed.category.trim()
      ? parsed.category.trim()
      : "LLM explanation",
    related_terms: Array.isArray(parsed.related_terms)
      ? parsed.related_terms.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 6)
      : [],
    usage_example: includeUsageExample && typeof parsed.usage_example === "string"
      ? parsed.usage_example.trim()
      : null,
    source_url: typeof parsed.source_url === "string" ? parsed.source_url : null,
    provider_status: "llm"
  };
  return {
    term,
    context: context || term,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.7,
    explanation
  };
}

export function assertScreenshotDataUrl(value: string): void {
  const match = value.match(SCREENSHOT_DATA_URL_PATTERN);
  if (
    value.length > MAX_SCREENSHOT_DATA_URL_LENGTH
    || !match
    || match[1].length % 4 !== 0
  ) {
    throw new Error("The selected screenshot is invalid or too large.");
  }
}

export function splitImageDataUrl(value: string): { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string } {
  assertScreenshotDataUrl(value);
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    throw new Error("The selected screenshot format is not supported.");
  }
  return {
    mediaType: match[1].toLocaleLowerCase() as "image/png" | "image/jpeg" | "image/webp",
    data: match[2]
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
