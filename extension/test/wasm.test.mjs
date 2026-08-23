// Behavioral test for the committed termpop-core WASM artifact.
// Runs against extension/src/wasm without rebuilding, so it fails in CI
// whenever the committed binary drifts from the Rust sources.
// Usage: node extension/test/wasm.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import init, { detect_terms_json, detect_terms_with_dictionary_json } from "../src/wasm/termpop_core.js";

const wasmPath = fileURLToPath(new URL("../src/wasm/termpop_core_bg.wasm", import.meta.url));
await init(readFileSync(wasmPath));

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
const labels = (text) => JSON.parse(detect_terms_json(text)).map((t) => t.term);

// The public build deliberately ships without a fixed default list. Terms come
// from the user's local cache or an explicitly configured dictionary.
check("default detector is empty", labels("Rust React AWS LLM ChatGPT"), []);
check("default detector remains empty next to CJK", labels("使用Rust开发很方便"), []);

// Dictionary and user terms: boundaries and case-insensitive matching.
{
  const dict = JSON.stringify([{ term: "TermPop" }, { term: "Rust" }]);
  check("dict: adjacent CJK", JSON.parse(detect_terms_with_dictionary_json("我喜欢TermPop这个工具", dict)).map((t) => t.term), ["TermPop"]);
  check("dict: embedded rejected", JSON.parse(detect_terms_with_dictionary_json("xTermPop 和 TermPopX", dict)), []);
  check("dict: Rust adjacent CJK", JSON.parse(detect_terms_with_dictionary_json("使用Rust开发很方便", dict)).map((t) => t.term), ["Rust"]);
}
{
  const dict = JSON.stringify([{ term: "kubernetes" }]);
  check("dict: case-insensitive", JSON.parse(detect_terms_with_dictionary_json("Kubernetes 集群很稳定", dict)).map((t) => t.term), ["Kubernetes"]);
  const dict2 = JSON.stringify({ base: [], domain: [], user: [{ term: "termpop" }] });
  check("user: case-insensitive", JSON.parse(detect_terms_with_dictionary_json("TermPop 和 TERMPOP 都命中", dict2)).map((t) => t.term), ["TermPop", "TERMPOP"]);
}

// Reported start/end must be correct UTF-8 byte offsets on non-ASCII text.
{
  const text = "😀 Rust"; // emoji = 4 UTF-8 bytes, 2 UTF-16 code units
  const terms = JSON.parse(detect_terms_with_dictionary_json(text, JSON.stringify([{ term: "Rust" }])));
  check("emoji text detects Rust", terms.map((t) => t.term), ["Rust"]);
  const bytes = new TextEncoder().encode(text);
  check("emoji byte slice roundtrip", new TextDecoder().decode(bytes.slice(terms[0].start, terms[0].end)), "Rust");
}
{
  const text = "使用Rust开发很方便";
  const terms = JSON.parse(detect_terms_with_dictionary_json(text, JSON.stringify([{ term: "Rust" }])));
  const bytes = new TextEncoder().encode(text);
  check("CJK byte slice roundtrip", new TextDecoder().decode(bytes.slice(terms[0].start, terms[0].end)), "Rust");
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nALL PASS");
