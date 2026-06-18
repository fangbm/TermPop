# TermLens Phase 1 Development Plan

## Summary

Phase 1 builds the first usable TermLens loop for Chrome and Edge:

1. Scan browser page text.
2. Detect technical and proper terms through the Rust core compiled to WASM.
3. Highlight detected terms in the page.
4. Show a hover explanation card backed by a configurable LLM provider, with mock fallback.

Native desktop overlays, encrypted API key storage, persistent caches, and mobile support are deferred.

## Architecture

```text
TermLens/
├── crates/
│   └── termlens-core/     # Rust core and WASM exports
├── extension/             # Manifest V3 browser extension
└── docs/
```

The Rust crate owns the canonical data contracts and detection behavior. The browser extension loads the generated WASM module and asks the background service worker for explanations.

## Rust Core

`termlens-core` provides:

- `DetectedTerm`, `TermType`, `DetectionSource`, `Explanation`, and `DetectorConfig`.
- Rule detection for languages, frameworks, cloud platforms, AI products, and common acronyms.
- User term detection with `Custom` source/type.
- Deduplication by overlapping byte span, preferring higher confidence.
- Mock explanations for local development.
- WASM exports:
  - `detect_terms_json(input: &str) -> Result<String, JsValue>`
  - `explain_term_json(term: &str, context: Option<String>) -> Result<String, JsValue>`

## Browser Extension

The extension targets Chrome/Edge Manifest V3.

- `auto` mode scans the page after load and highlights detected terms.
- `hover` and `hybrid` are persisted in settings but intentionally conservative in Phase 1.
- The content script skips script/style/form/editable content and avoids rescanning existing highlights.
- Highlighting is performed by replacing individual text nodes, which avoids unsafe HTML injection.
- Hovering a highlight renders a bounded card near the highlighted term.
- The background worker caches mock explanations in memory for the current browser session.
- LLM settings are configured in the popup. Supported providers are `mock`, `openai`, `kimi`, `openai-compatible`, and `anthropic`.
- OpenAI, Kimi, and custom providers use OpenAI-compatible `/chat/completions`; Anthropic uses `/messages`.
- If the provider is `mock` or no API key is configured, TermLens falls back to the Rust mock explanation.
- API keys are currently stored in `chrome.storage.local`; this is suitable for local Phase 1 testing, not final secure storage.

## Commands

```powershell
cargo test --workspace
wasm-pack build crates/termlens-core --target web --out-dir ../../extension/src/wasm --features wasm
cd extension
npm install
npm run typecheck
npm run build
```

Load `extension/dist` as an unpacked extension in Chrome or Edge.

## Acceptance Criteria

- Rust tests pass.
- WASM build creates `extension/src/wasm/termlens_core.js` and `termlens_core_bg.wasm`.
- Extension typecheck and production build pass.
- On a page containing `Rust React AWS LLM ChatGPT`, detected terms are highlighted.
- Hovering a highlighted term shows an explanation card.
- Popup mode selection persists through `chrome.storage.local`.
- Popup LLM settings persist through `chrome.storage.local`.
- With a valid provider key, hover explanations come from the selected LLM; without a key, mock explanations still work.
