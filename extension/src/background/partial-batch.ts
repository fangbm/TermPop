export interface PartialBatchSuccess<TItem, TValue> {
  index: number;
  item: TItem;
  value: TValue;
}

export interface PartialBatchFailure<TItem> {
  index: number;
  item: TItem;
  error: unknown;
}

export class PartialBatchAllFailedError extends Error {
  readonly failedIndexes: number[];

  constructor(label: string, failedIndexes: number[]) {
    super(`${label} failed for all ${failedIndexes.length} items.`);
    this.name = "PartialBatchAllFailedError";
    this.failedIndexes = failedIndexes;
  }
}

export async function runPartialBatch<TItem, TValue>(
  items: readonly TItem[],
  run: (item: TItem, index: number) => Promise<TValue>,
  options: { continueOnError?: (error: unknown, item: TItem, index: number) => boolean } = {}
): Promise<{
  successes: Array<PartialBatchSuccess<TItem, TValue>>;
  failures: Array<PartialBatchFailure<TItem>>;
}> {
  const successes: Array<PartialBatchSuccess<TItem, TValue>> = [];
  const failures: Array<PartialBatchFailure<TItem>> = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      successes.push({ index, item, value: await run(item, index) });
    } catch (error) {
      if (!options.continueOnError?.(error, item, index)) {
        throw error;
      }
      failures.push({ index, item, error });
    }
  }
  return { successes, failures };
}

export function assertPartialBatchSuccess(
  result: { successes: readonly unknown[]; failures: readonly unknown[] },
  label: string
): void {
  if (result.failures.length > 0 && result.successes.length === 0) {
    const failedIndexes = result.failures.map((failure, index) => {
      if (failure && typeof failure === "object" && "index" in failure) {
        const value = (failure as { index?: unknown }).index;
        if (typeof value === "number") {
          return value;
        }
      }
      return index;
    });
    throw new PartialBatchAllFailedError(label, failedIndexes);
  }
}
