export interface PdfSessionToken {
  id: number;
  cancelled: boolean;
  llmQueueRunning: boolean;
  llmQueueDirty: boolean;
}

export function createPdfSessionToken(id: number): PdfSessionToken {
  return {
    id,
    cancelled: false,
    llmQueueRunning: false,
    llmQueueDirty: false
  };
}

export function cancelPdfSessionToken(session: PdfSessionToken): void {
  session.cancelled = true;
  session.llmQueueDirty = false;
}

export function isPdfSessionCurrent<T extends PdfSessionToken>(active: T | undefined, candidate: T): boolean {
  return active === candidate && !candidate.cancelled;
}

export async function drainPdfLlmQueue<TSession extends PdfSessionToken, TItem>(
  session: TSession,
  isCurrent: () => boolean,
  getPendingItems: () => TItem[],
  runItem: (item: TItem) => Promise<void>
): Promise<void> {
  if (session.llmQueueRunning) {
    session.llmQueueDirty = true;
    return;
  }

  session.llmQueueRunning = true;
  try {
    do {
      session.llmQueueDirty = false;
      for (const item of getPendingItems()) {
        if (!isCurrent()) {
          return;
        }
        await runItem(item);
      }
    } while (isCurrent() && session.llmQueueDirty);
  } finally {
    session.llmQueueRunning = false;
  }
}
