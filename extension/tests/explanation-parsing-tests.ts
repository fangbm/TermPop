import { parseExplanation } from "../src/background/explanation-parsing.ts";

const code = parseExplanation(JSON.stringify({
  term: "Array.prototype.map",
  kind: "code",
  definition: "Creates a new array by applying a callback to every item.",
  category: "JavaScript method",
  sections: [
    { label: "Purpose", content: "Transforms each item without mutating the original array." },
    { label: "Pitfall", content: "Use for transformations, not side effects." }
  ],
  related_terms: ["callback", "Array"],
  usage_example: null
}), "items.map(fn)", false);

equal(code.kind, "code");
equal(code.sections?.length, 2);
equal(code.sections?.[1].label, "Pitfall");

const ordinary = parseExplanation(JSON.stringify({
  term: "Transformer",
  definition: "An attention-based neural network architecture.",
  category: "Machine learning",
  related_terms: []
}), "Transformer", false);

equal(ordinary.kind, undefined);
equal(ordinary.sections, undefined);

const unsafe = parseExplanation(JSON.stringify({
  term: "Error",
  kind: "not-a-kind",
  definition: "A problem occurred.",
  category: "Runtime",
  sections: [{ label: "", content: "ignored" }, { label: "Cause", content: "Bad input" }],
  related_terms: []
}), "Error", false);

equal(unsafe.kind, undefined);
equal(unsafe.sections?.length, 1);
equal(unsafe.sections?.[0].label, "Cause");

console.log("ok - explanation parsing");

function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}.`);
  }
}
