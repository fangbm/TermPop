# TermLens Windows App

This branch contains the first native Windows test shell for TermLens.

## Scope

The Windows app is intentionally small:

- Paste or type text into a desktop window.
- Import text directly from the clipboard.
- Capture currently selected text after a short delay by sending `Ctrl+C`.
- Detect terms with `termlens-core`.
- Add comma-separated custom terms.
- Preview detected terms with desktop highlighting.
- Select a term and generate a local mock explanation.

The browser extension remains the primary Phase 1 delivery surface. The Windows app is the start of a native desktop surface and currently does not call external LLM providers.

Text capture intentionally avoids OCR. The current build reads text from the clipboard or from a selectable region that supports copy. Future builds can add Windows UI Automation for direct accessibility-tree extraction.

## Commands

```powershell
cargo run -p termlens-windows
cargo check -p termlens-windows
cargo test --workspace
```

To capture selected text without OCR:

1. Select text in a browser, chat window, editor, or document.
2. In TermLens, click `2秒后抓取选区`.
3. Switch back to the source window before the countdown ends.
4. TermLens sends `Ctrl+C`, imports the copied text, and restores the previous clipboard text when possible.

## Next Steps

- Move provider settings and LLM calls into a shared Rust module.
- Add encrypted local storage for API keys.
- Add global term cache import/export.
- Add Windows UI Automation text extraction for controls that expose accessibility text.
- Add Windows installer packaging.
