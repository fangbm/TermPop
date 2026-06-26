# TermLens Tauri Windows App

This app is the Tauri replacement path for the earlier egui Windows prototype.

## Scope

- A regular `settings` window controls capture behavior.
- A transparent, always-on-top `overlay` window draws highlights at UI Automation text rectangles.
- The overlay is mouse-pass-through by default, so source applications remain clickable.
- Rust commands reuse `termlens-core` and the existing Windows UI Automation capture pipeline.
- The first version auto-shows the explanation for the first detected term near the source rectangle.
- The settings window includes LLM provider configuration and a connection test log.
- LLM HTTP requests are sent from the Rust backend to avoid WebView CORS issues.

## Commands

```powershell
cd apps\termlens-tauri
npm install
npm run dev
npm run typecheck
npm run build -- --no-bundle
```

The no-bundle build produces:

```text
target\release\termlens-tauri.exe
```

## LLM Settings

The settings window stores LLM configuration in local app `localStorage`:

- Provider: `mock`, OpenAI, Kimi, OpenAI-compatible / StepFun, or Anthropic.
- Base URL, model, API key, language, temperature, max tokens, and example generation.
- `测试 LLM` sends a small JSON-only prompt and appends the result to the test log.
- Overlay explanations use the configured provider when the provider is not `mock` and an API key is present; otherwise they fall back to Rust mock explanations.

## Current Limits

- The overlay depends on UI Automation `TextPattern` rectangles. Apps that do not expose TextPattern may only provide text without exact term rectangles.
- Hover interaction over the original term is not enabled yet because the overlay is mouse-pass-through by default.
- The capture module is temporarily reused from `apps/termlens-windows`; it should be extracted into a shared Rust crate once the Tauri path stabilizes.
