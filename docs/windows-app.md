# TermLens Windows App

This branch contains the first native Windows test shell for TermLens.

## Scope

The Windows app is intentionally small:

- Paste or type text into a desktop window.
- Import text directly from the clipboard.
- Capture currently selected text after a short delay by sending `Ctrl+C`.
- Capture accessible text under the mouse with Windows UI Automation.
- Run a first-pass "smart capture" pipeline: UI Automation, selection copy, then OCR placeholder.
- Detect terms with `termlens-core`.
- Add comma-separated custom terms.
- Preview detected terms with desktop highlighting.
- Select a term and generate a local mock explanation.

The browser extension remains the primary Phase 1 delivery surface. The Windows app is the start of a native desktop surface and currently does not call external LLM providers.

Text capture intentionally avoids OCR. The current build reads text from the clipboard, selectable regions that support copy, and Windows UI Automation for controls that expose accessibility text. OCR remains a disabled placeholder and is only a future fallback.

## Commands

```powershell
cargo run -p termlens-windows
cargo check -p termlens-windows
cargo test --workspace
```

To capture text without OCR:

1. Click `2秒后智能提取`.
2. Move the mouse over the target text, or keep text selected in the source application.
3. TermLens first tries Windows UI Automation at the mouse location.
4. If UI Automation does not expose text, TermLens sends `Ctrl+C`, imports the copied text, and restores the previous clipboard text when possible.

## Next Steps

- Move provider settings and LLM calls into a shared Rust module.
- Add encrypted local storage for API keys.
- Add global term cache import/export.
- Expand Windows UI Automation extraction with TextPattern and ValuePattern support.
- Add Windows installer packaging.
