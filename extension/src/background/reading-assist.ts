import { createLlmProvider } from "./llm-provider";
import { assertLlmProviderAuthorized } from "./provider-access";
import { buildBatchExplanationPrompt, buildReadingAssistSystemPrompt, buildReadingSummaryPrompt } from "./prompts";
import { parseReadingAssistResult } from "./reading-assist-parsing";
import type { LlmSettings, ReadingAssistKind, ReadingAssistResult } from "../shared/types";

const MAX_VISIBLE_TEXT_LENGTH = 9_000;
const MAX_SELECTED_TEXT_LENGTH = 6_000;
const REQUEST_TIMEOUT_MS = 45_000;

export async function generateReadingAssist(
  kind: ReadingAssistKind,
  text: string,
  settings: LlmSettings
): Promise<ReadingAssistResult> {
  const normalized = text.replace(/\s+/g, " ").trim();
  const limit = kind === "summary" ? MAX_VISIBLE_TEXT_LENGTH : MAX_SELECTED_TEXT_LENGTH;
  if (normalized.length < 12) {
    throw new Error("Select or display a little more text before asking TermPop.");
  }

  await assertLlmProviderAuthorized(settings);
  const prompt = kind === "summary"
    ? buildReadingSummaryPrompt(normalized.slice(0, limit))
    : buildBatchExplanationPrompt(normalized.slice(0, limit));
  const raw = await createLlmProvider(settings).detectTerms(
    prompt,
    buildReadingAssistSystemPrompt(settings.language),
    settings,
    REQUEST_TIMEOUT_MS
  );
  return parseReadingAssistResult(kind, raw);
}
