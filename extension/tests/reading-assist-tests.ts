import { parseReadingAssistResult } from "../src/background/reading-assist-parsing.ts";

const summary = parseReadingAssistResult("summary", `Before the JSON, the model talks.\n{
  "summary": ["Transformer replaces recurrence with attention.", "It improves parallelism."],
  "structure": ["Problem", "Approach", "Result"],
  "terms": ["Transformer", "self-attention", "BLEU"]
}`);

equal(summary.summary?.length, 2);
equal(summary.structure?.[1], "Approach");
equal(summary.terms?.[2], "BLEU");

const batch = parseReadingAssistResult("batch", JSON.stringify({
  items: [
    { term: "Transformer", explanation: "An attention-based sequence architecture." },
    { term: "BLEU", explanation: "A machine translation evaluation metric." }
  ]
}));

equal(batch.items?.length, 2);
equal(batch.items?.[0].term, "Transformer");

let rejected = false;
try {
  parseReadingAssistResult("batch", JSON.stringify({ items: [{ term: "", explanation: "missing" }] }));
} catch {
  rejected = true;
}
if (!rejected) {
  throw new Error("Expected empty batch items to be rejected.");
}

console.log("ok - reading assist result parsing");

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}.`);
  }
}
