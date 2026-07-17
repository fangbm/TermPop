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

// ASCII terms next to CJK text must be detected (regex \b treats CJK
// characters as word characters and would suppress these matches).
check("CJK: 使用Rust开发很方便", labels("使用Rust开发很方便"), ["Rust"]);
check("CJK: 用Python写脚本", labels("用Python写脚本"), ["Python"]);
check("CJK: 用 Python 写脚本", labels("用 Python 写脚本"), ["Python"]);
check("CJK: mixed", labels("在AWS上部署Kubernetes风格的React应用"), ["AWS", "React"]);
check("edge: Rust语言值得学习", labels("Rust语言值得学习"), ["Rust"]);

// Partial matches inside longer ASCII words stay rejected.
check("reject: RustLang / xReact", labels("RustLang 和 xReact 都不是术语"), []);
check("reject: JARVIS vs JAR", labels("JARVIS 不是 JAR"), ["JAR"]);

// Baseline rule behavior.
check("seed terms", labels("Rust React AWS LLM ChatGPT"), ["Rust", "React", "AWS", "LLM", "ChatGPT"]);
check("chinese cloud", labels("我们使用阿里云和腾讯云部署服务。"), ["阿里云", "腾讯云"]);
check("minecraft", labels("JAR Paper Fabric level.dat region .mca save-all bash"),
  ["JAR", "Paper", "Fabric", "level.dat", "region", ".mca", "save-all", "bash"]);
check("minecraft next to CJK", labels("JAR缺失导致崩溃，region 目录里的 .mca 文件"), ["JAR", "region", ".mca"]);

// Dictionary and user terms: boundaries and case-insensitive matching.
{
  const dict = JSON.stringify([{ term: "TermPop" }]);
  check("dict: adjacent CJK", JSON.parse(detect_terms_with_dictionary_json("我喜欢TermPop这个工具", dict)).map((t) => t.term), ["TermPop"]);
  check("dict: embedded rejected", JSON.parse(detect_terms_with_dictionary_json("xTermPop 和 TermPopX", dict)), []);
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
  const terms = JSON.parse(detect_terms_json(text));
  check("emoji text detects Rust", terms.map((t) => t.term), ["Rust"]);
  const bytes = new TextEncoder().encode(text);
  check("emoji byte slice roundtrip", new TextDecoder().decode(bytes.slice(terms[0].start, terms[0].end)), "Rust");
}
{
  const text = "使用Rust开发很方便";
  const terms = JSON.parse(detect_terms_json(text));
  const bytes = new TextEncoder().encode(text);
  check("CJK byte slice roundtrip", new TextDecoder().decode(bytes.slice(terms[0].start, terms[0].end)), "Rust");
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log(`\nALL PASS (18 assertions)`);
