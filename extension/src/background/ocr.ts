import type { OcrImageResult, RunOcrRequest, RunOcrResponse } from "../shared/types";

const OFFSCREEN_DOCUMENT_PATH = "assets/ocr.html";
let creatingOffscreenDocument: Promise<void> | undefined;

export async function recognizeWithLocalOcr(
  termImageDataUrl: string,
  contextImageDataUrl: string
): Promise<OcrImageResult> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "TERMPOP_RUN_OCR",
    target: "offscreen",
    termImageDataUrl,
    contextImageDataUrl
  } satisfies RunOcrRequest) as RunOcrResponse;
  if (!response.ok || !response.result) {
    throw new Error(response.error || "Local OCR did not return a result.");
  }
  return response.result;
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl]
  });
  if (existing.length > 0) {
    return;
  }
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run the bundled Tesseract OCR worker for user-selected screenshots."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  await creatingOffscreenDocument;
}
