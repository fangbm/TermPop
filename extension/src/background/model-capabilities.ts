import type { LlmSettings } from "../shared/types";

export type ImageInputCapability = "supported" | "unsupported" | "unknown";

export function inferImageInputCapability(settings: LlmSettings): ImageInputCapability {
  if (settings.provider === "mock" || !settings.apiKey.trim()) {
    return "unsupported";
  }

  const model = settings.model.trim().toLocaleLowerCase();
  if (!model) {
    return "unknown";
  }
  if (/(?:^|[-_.])(embedding|moderation|whisper|tts|transcri(?:be|ption)|speech)(?:[-_.]|$)/i.test(model)) {
    return "unsupported";
  }
  if (settings.provider === "anthropic" && /^claude-(?:3|sonnet-4|opus-4)/i.test(model)) {
    return "supported";
  }
  if (/^(?:gpt-(?:4o|4\.1|5)|o[134])(?:[-_.]|$)/i.test(model)) {
    return "supported";
  }
  if (/(?:vision|[-_.]vl(?:[-_.]|$)|step-(?:1v|1\.5v))/i.test(model)) {
    return "supported";
  }
  return "unknown";
}

export function shouldStartWithOcr(settings: LlmSettings): boolean {
  if (settings.screenshotRecognitionMode === "ocr") {
    return true;
  }
  if (settings.screenshotRecognitionMode === "multimodal") {
    return false;
  }
  return inferImageInputCapability(settings) === "unsupported";
}

export function isImageInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:image(?:_url)?|vision|visual|multimodal).{0,80}(?:unsupported|not supported|invalid|does not support|unavailable)|(?:unsupported|not supported|does not support).{0,80}(?:image|vision|visual|multimodal)/i.test(message);
}
