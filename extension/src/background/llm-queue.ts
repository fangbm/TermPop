import type { LlmSettings } from "../shared/types";

export type LlmPriority = "explanation" | "detection";

export interface LlmRunOptions {
  priority: LlmPriority;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmConcurrencyController {
  run<T>(settings: LlmSettings, options: LlmRunOptions, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

interface QueueEntry {
  priority: LlmPriority;
  signal: AbortSignal;
  started: boolean;
  start: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const EXPLANATION_BURST_LIMIT = 3;

export function createLlmConcurrencyController(): LlmConcurrencyController {
  let activeRequests = 0;
  let currentLimit = 1;
  let consecutiveExplanations = 0;
  const explanationQueue: QueueEntry[] = [];
  const detectionQueue: QueueEntry[] = [];

  function schedule(): void {
    discardAbortedEntries();
    while (activeRequests < currentLimit && (explanationQueue.length > 0 || detectionQueue.length > 0)) {
      const next = takeNextEntry();
      if (!next) {
        return;
      }
      activeRequests += 1;
      next.started = true;
      next.start();
    }
  }

  function takeNextEntry(): QueueEntry | undefined {
    const explanationAvailable = explanationQueue.length > 0;
    const detectionAvailable = detectionQueue.length > 0;
    let queue: QueueEntry[];

    // Explanations are preferred, but a detection is admitted after a short burst.
    if (explanationAvailable && (!detectionAvailable || consecutiveExplanations < EXPLANATION_BURST_LIMIT)) {
      queue = explanationQueue;
      consecutiveExplanations += 1;
    } else if (detectionAvailable) {
      queue = detectionQueue;
      consecutiveExplanations = 0;
    } else {
      return undefined;
    }

    return queue.shift();
  }

  function discardAbortedEntries(): void {
    for (const queue of [explanationQueue, detectionQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].signal.aborted) {
          queue.splice(index, 1);
        }
      }
    }
  }

  function remove(entry: QueueEntry): void {
    for (const queue of [explanationQueue, detectionQueue]) {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
      }
    }
  }

  function cancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("LLM request was cancelled.");
  }

  async function run<T>(settings: LlmSettings, options: LlmRunOptions, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    currentLimit = normalizeConcurrency(settings.maxConcurrency);
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let entry!: QueueEntry;
    let rejectStart!: (error: Error) => void;

    const startPromise = new Promise<void>((resolve, reject) => {
      rejectStart = reject;
      entry = {
        priority: options.priority,
        signal: controller.signal,
        started: false,
        start: resolve
      };
      (options.priority === "explanation" ? explanationQueue : detectionQueue).push(entry);
      schedule();
    });

    timeoutId = setTimeout(() => abort(new Error("LLM request timed out.")), timeoutMs);

    const abort = (reason: unknown): void => {
      const error = reason instanceof Error ? reason : new Error("LLM request was cancelled.");
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      if (!entry.started) {
        remove(entry);
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        rejectStart(error);
        schedule();
      }
    };

    const onExternalAbort = (): void => abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) {
        abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    try {
      await startPromise;
      if (controller.signal.aborted) {
        throw cancellationError(controller.signal);
      }
      return await task(controller.signal);
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (entry.started) {
        activeRequests = Math.max(0, activeRequests - 1);
        schedule();
      }
    }
  }

  return { run };
}

const defaultController = createLlmConcurrencyController();

export function runWithLlmConcurrency<T>(settings: LlmSettings, options: LlmRunOptions, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return defaultController.run(settings, options, task);
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(Math.round(value), 1);
}
