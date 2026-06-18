# TermLens Windows App

This branch contains the first native Windows test shell for TermLens.

## Scope

The Windows app is intentionally small:

- Paste or type text into a desktop window.
- Detect terms with `termlens-core`.
- Add comma-separated custom terms.
- Preview detected terms with desktop highlighting.
- Select a term and generate a local mock explanation.

The browser extension remains the primary Phase 1 delivery surface. The Windows app is the start of a native desktop surface and currently does not call external LLM providers.

## Commands

```powershell
cargo run -p termlens-windows
cargo check -p termlens-windows
cargo test --workspace
```

## Next Steps

- Move provider settings and LLM calls into a shared Rust module.
- Add encrypted local storage for API keys.
- Add global term cache import/export.
- Add Windows installer packaging.
