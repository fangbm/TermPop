import initWasm, { detect_terms_json, detect_terms_with_dictionary_json, explain_term_json } from "../wasm/termpop_core.js";

const wasmReady = initWasm({ module_or_path: chrome.runtime.getURL("assets/termpop_core_bg.wasm") });

export async function detectWithWasm(text: string, dictionaryJson?: string): Promise<string> {
  await wasmReady;
  return dictionaryJson
    ? detect_terms_with_dictionary_json(text, dictionaryJson)
    : detect_terms_json(text);
}

export async function explainWithWasm(term: string, context: string | undefined): Promise<string> {
  await wasmReady;
  return explain_term_json(term, context);
}
