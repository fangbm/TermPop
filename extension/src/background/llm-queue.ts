import type { LlmSettings } from "../shared/types";

export type LlmPriority = "explanation" | "detection";

interface LlmRunOptions {
  priority: LlmPriority;
  timeoutMs?: number;
}

interface LlmQueueEntry {
  start: () => void;
  signal: AbortSignal;
  priority: LlmPriority;
  maxActiveRequests: number;
}

let activeExplanationRequests = 0;
let activeDetectionRequests = 0;
const explanationQueue: LlmQueueEntry[] = [];
const detectionQueue: LlmQueueEntry[] = [];

export async function runWithLlmConcurrency<T>(
  settings: LlmSettings,
  options: LlmRunOptions,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: number | undefined;

  if (options.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => controller.abort(new Error("LLM request timed out.")), options.timeoutMs);
  }

  await acquireLlmSlot(settings, options.priority, controller.signal);
  try {
    return await task(controller.signal);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    releaseLlmSlot(options.priority);
  }
}

async function acquireLlmSlot(settings: LlmSettings, priority: LlmPriority, signal: AbortSignal): Promise<void> {
  const limit = normalizeConcurrency(settings.maxConcurrency);
  const maxActiveRequests = maxActiveRequestsForPriority(priority, limit);
  if (activeRequestsForPriority(priority) < maxActiveRequests) {
    incrementActiveRequests(priority);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let entry: LlmQueueEntry;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      removeQueuedEntry(entry);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("LLM request was cancelled."));
    };

    entry = {
      signal,
      priority,
      maxActiveRequests,
      start: () => {
        cleanup();
        incrementActiveRequests(priority);
        resolve();
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    queueForPriority(priority).push(entry);
  });
}

function scheduleNextLlmRequest(): void {
  const explanation = takeStartableEntry(explanationQueue);
  if (explanation) {
    explanation.start();
    return;
  }

  takeStartableEntry(detectionQueue)?.start();
}

function takeStartableEntry(queue: LlmQueueEntry[]): LlmQueueEntry | undefined {
  const index = queue.findIndex((entry) => !entry.signal.aborted && activeRequestsForPriority(entry.priority) < entry.maxActiveRequests);
  if (index < 0) {
    return undefined;
  }
  const [entry] = queue.splice(index, 1);
  return entry;
}

function removeQueuedEntry(entry: LlmQueueEntry): void {
  removeFromQueue(explanationQueue, entry);
  removeFromQueue(detectionQueue, entry);
}

function removeFromQueue(queue: LlmQueueEntry[], entry: LlmQueueEntry): void {
  const index = queue.indexOf(entry);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function queueForPriority(priority: LlmPriority): LlmQueueEntry[] {
  return priority === "explanation" ? explanationQueue : detectionQueue;
}

function maxActiveRequestsForPriority(priority: LlmPriority, limit: number): number {
  if (priority === "explanation") {
    return Math.max(1, limit);
  }
  return Math.max(1, Math.min(limit - activeExplanationRequests, limit));
}

function releaseLlmSlot(priority: LlmPriority): void {
  decrementActiveRequests(priority);
  scheduleNextLlmRequest();
}

function activeRequestsForPriority(priority: LlmPriority): number {
  return priority === "explanation" ? activeExplanationRequests : activeDetectionRequests;
}

function incrementActiveRequests(priority: LlmPriority): void {
  if (priority === "explanation") {
    activeExplanationRequests += 1;
    return;
  }

  activeDetectionRequests += 1;
}

function decrementActiveRequests(priority: LlmPriority): void {
  if (priority === "explanation") {
    activeExplanationRequests = Math.max(0, activeExplanationRequests - 1);
    return;
  }

  activeDetectionRequests = Math.max(0, activeDetectionRequests - 1);
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(Math.round(value), 1);
}
