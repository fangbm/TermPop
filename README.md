# TermPop

TermPop is a Chrome/Edge Manifest V3 browser extension that detects technical terms on web pages and explains them in a small hover card.

It combines a Rust detection core compiled to WebAssembly with a TypeScript browser extension. The current public build focuses on local browser usage: scan page text, highlight terms, and show contextual explanations through either a mock provider or a user-configured LLM provider.

## Features

- Page text scanning and safe text-node highlighting.
- Rust/WASM term detection for programming languages, frameworks, cloud services, AI products, common acronyms, Minecraft/server terms, and custom user terms.
- Hover explanation cards with refresh support.
- Selection mode: select text and use the context menu to request an explanation.
- Hybrid mode: automatic highlights plus selection-based explanations.
- Local explanation and term caches to reduce repeated requests.
- Built-in PDF viewer for TermPop-managed PDF reading and highlighting.
- Chrome/Edge Manifest V3 extension build.

## Project Layout

```text
TermPop/
├── crates/
│   └── termpop-core/       # Rust detection core and WASM exports
├── extension/              # Browser extension source
│   ├── src/background/     # MV3 service worker
│   ├── src/content/        # Page scanning and highlights
│   ├── src/pdf-viewer/     # TermPop PDF viewer
│   ├── src/popup/          # Extension popup UI
│   └── src/shared/         # Shared settings, overlay, and types
├── docs/                   # Development notes
└── .github/workflows/      # Extension release automation
```

## Quick Install

The easiest way to try TermPop is to download the latest extension zip from GitHub Releases:

[Latest releases](https://github.com/fangbm/TermPop/releases)

Then:

1. Unzip the downloaded package.
2. Open Chrome or Edge extension management.
3. Enable developer mode.
4. Choose "Load unpacked".
5. Select the unzipped extension directory.

## Build Locally

Requirements:

- Rust stable
- Node.js 22 or newer
- `wasm-pack`

Install `wasm-pack` if needed:

```powershell
cargo install wasm-pack --locked
```

Build and test:

```powershell
cargo test --workspace
wasm-pack build crates/termpop-core --target web --out-dir ../../extension/src/wasm -- --features wasm
cd extension
npm install
npm run typecheck
npm run build
```

Load the generated extension from:

```text
extension/dist
```

## Usage

Open the extension popup to choose a mode:

- Hover: automatically scan the page, highlight detected terms, and show explanations on hover.
- Selection: select text, then use the browser context menu explanation action.
- Hybrid: enable both hover highlights and selection explanations.

The public build still stores local LLM settings in browser extension storage. For private testing this is convenient, but it is not a final security model for hosted or commercial use.

## LLM Providers

TermPop can use:

- Mock explanations for local testing.
- OpenAI-compatible chat completions endpoints.
- Kimi/OpenAI-compatible providers.
- Anthropic-style message endpoints.

If no usable provider key is configured, TermPop falls back to the Rust mock explanation flow.

## Release Automation

Every push to `main` runs the GitHub Actions workflow:

```text
.github/workflows/extension-release.yml
```

The workflow:

1. Runs Rust tests.
2. Builds the WASM core.
3. Installs extension dependencies.
4. Runs TypeScript typecheck.
5. Builds the extension.
6. Packages `extension/dist` as a zip.
7. Creates a GitHub Release with commit-log release notes.

## Current Limitations

- Direct injection into the browser's built-in PDF viewer is not supported reliably; use the TermPop PDF viewer instead.
- Native desktop overlays are not part of the public mainline.
- API keys in the public extension are local development settings, not hardened secret storage.
- Detection is intentionally conservative in some contexts to avoid breaking page layout or links.

## License

MIT
