import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { RunOcrRequest, RunOcrResponse } from "../shared/types";

let workerPromise: Promise<Worker> | undefined;

chrome.runtime.onMessage.addListener((message: RunOcrRequest, _sender, sendResponse) => {
  if (message.type !== "TERMPOP_RUN_OCR" || message.target !== "offscreen") {
    return false;
  }
  runOcr(message)
    .then((result) => sendResponse({ ok: true, result } satisfies RunOcrResponse))
    .catch((error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies RunOcrResponse));
  return true;
});

async function runOcr(message: RunOcrRequest) {
  const worker = await getWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    preserve_interword_spaces: "1"
  });
  const termResult = await worker.recognize(message.termImageDataUrl);
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1"
  });
  const contextResult = await worker.recognize(message.contextImageDataUrl);
  const termText = cleanSelectedTerm(termResult.data.text);
  if (!termText) {
    throw new Error("Local OCR could not identify text in the selected area.");
  }
  return {
    termText,
    contextText: cleanOcrText(contextResult.data.text).slice(0, 1600) || termText,
    confidence: clamp(Number(termResult.data.confidence) / 100, 0, 1)
  };
}

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
    workerPath: chrome.runtime.getURL("assets/ocr/worker.min.js"),
    corePath: chrome.runtime.getURL("assets/ocr/core/"),
    langPath: chrome.runtime.getURL("assets/ocr/lang/"),
    gzip: false,
    workerBlobURL: false,
    logger: () => undefined,
    errorHandler: (error) => {
      workerPromise = undefined;
      console.warn("TermPop local OCR worker failed.", String(error).slice(0, 300));
    }
  });
  return workerPromise;
}

export function cleanSelectedTerm(value: string): string {
  return cleanOcrText(value)
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .slice(0, 120);
}

export function cleanOcrText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
