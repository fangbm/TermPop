# TermPop

[简体中文](README.zh-CN.md) | English

**Understand technical terms without leaving the page.**

TermPop is an open-source browser extension for Chrome and Microsoft Edge. It highlights technical vocabulary while you read, then shows concise, context-aware explanations where the term appears. The extension uses a Rust core compiled to WebAssembly for local matching and can optionally use your own LLM provider for richer detection and explanations.

> The public release is local-first and BYOK (bring your own key). TermPop does not provide an account service, hosted LLM proxy, or payment system.

## Install

### Microsoft Edge

Install directly from the [Microsoft Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/termpop/blphbffphknkkblackimhnjbckegnchn).

### Chrome or manual installation

1. Download the latest package from [GitHub Releases](https://github.com/fangbm/TermPop/releases).
2. Extract the ZIP file.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked**, then select the extracted extension directory.

## What TermPop Does

- **Hover mode** scans readable page text and highlights recognized technical terms.
- **Selection mode** lets you select text and choose the TermPop explanation action from the browser context menu.
- **Hybrid mode** enables both workflows.
- **Contextual explanation cards** support pinning, refresh, placement that adapts to available viewport space, and local caching.
- **Rust + WASM matching** checks locally cached terms inside the browser.
- **LLM enrichment** can add domain-specific terms and generate explanations through a provider you configure.
- **Screenshot explanation** lets you capture a word or short phrase that is not available as normal DOM text.
- **TermPop PDF Viewer** renders and annotates PDFs opened through TermPop. Direct injection into Chrome or Edge's built-in PDF viewer is intentionally not supported.

## First Use

1. Open the TermPop popup.
2. Choose **Hover**, **Selection**, or **Hybrid**.
3. Select **Enable TermPop on all websites** once to grant access to normal HTTP and HTTPS pages.
4. Use **Disable on this site** whenever you want to exclude a sensitive site, such as banking or email. The exclusion is stored locally as a blacklist.

Local `file://` pages are a separate browser permission and must be enabled separately in the extension details page.

TermPop deliberately does not request broad page access during installation. The first all-sites permission request is initiated from the popup, after you choose to enable it.

## Screenshot Explanation

Enable **Screenshot explanations** in the popup, then press `Alt+Shift+S` to draw around a word or short phrase on the active page. You can change the shortcut in `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`.

Choose one of three recognition modes:

- **Automatic** uses a configured image-capable model when TermPop can identify it; otherwise it starts with local OCR. If a vision request explicitly reports that image input is unsupported, it falls back to local OCR.
- **Multimodal LLM** sends the selected image and a small surrounding-context image to your configured provider.
- **Local OCR** uses the bundled Tesseract engine to read the image locally, then requests an explanation for the recognized text.

Screenshots are captured only after you begin a selection. They are not written to TermPop's term or explanation cache. When multimodal mode is used, the selected image is sent directly to the provider configured by you, so that provider's data policy applies.

## LLM and Privacy

TermPop supports OpenAI, Kimi, OpenAI-compatible, and Anthropic-style providers. Enter your provider, API key, model, and base URL in the popup. The connection test reuses the extension's existing page-access setup and does not ask for an additional provider permission.

The open-source build stores its settings, API key, blacklist, dictionaries, and caches in browser extension storage on your machine. API keys are not injected into website content scripts, but browser extension storage is **not hardened secret storage**. Use a restricted key where your provider supports it, and do not treat this build as a secure multi-user or commercial deployment.

TermPop does not include built-in telemetry or a TermPop-operated backend. Normal LLM requests send the requested term and its surrounding context to the provider you configure. Do not enable the extension on pages whose content you do not want your selected provider to receive.

## Dictionaries and Caches

The public build ships without a hardcoded default term list. LLM detection gradually builds a local, per-user term cache from the pages you choose to process. The extension keeps separate term and explanation caches to avoid unnecessary repeat work:

- Term entries can be reused globally, per domain, or for a single page context.
- Explanation entries are keyed by the term, language, model/provider, example setting, and context fingerprint.
- Cache data is local to the browser profile. Clear extension storage to remove it.

## Development

### Requirements

- Rust stable
- Node.js 22 or newer
- [`wasm-pack`](https://github.com/rustwasm/wasm-pack)

Install `wasm-pack` if needed:

```powershell
cargo install wasm-pack --locked
```

Build the Rust core, then the extension:

```powershell
cargo test --workspace
wasm-pack build crates/termpop-core --target web --out-dir ../../extension/src/wasm -- --features wasm

cd extension
npm ci
npm run typecheck
npm test
npm run build
```

Load [`extension/dist`](extension/dist) as an unpacked extension.

The product site is a separate React 19 application:

```powershell
cd apps/termpop-site
npm ci
npm run typecheck
npm run build
```

Cloudflare Pages uses `apps/termpop-site` as its root, `npm ci && npm run build` as its build command, and `dist` as its output directory.

## Project Structure

```text
TermPop/
├── crates/termpop-core/    Rust detection engine and WASM exports
├── extension/              Manifest V3 browser extension
│   ├── src/background/     Service worker, LLM, cache, OCR, permissions
│   ├── src/content/        Incremental page scanning, highlights, overlays
│   ├── src/pdf-viewer/     TermPop-managed PDF reader
│   ├── src/popup/          Extension settings UI
│   └── tests/              Extension regression tests
├── apps/termpop-site/      React 19 product site
├── docs/                   Design and development documentation
└── .github/workflows/      CI and release automation
```

## Limitations

- Direct annotation of Chrome or Edge's built-in PDF viewer is not supported. Use the TermPop PDF Viewer.
- TermPop skips links, code blocks, form controls, content-editable areas, and layout-sensitive text containers when automatic highlighting could change a page's layout.
- Screenshot recognition depends on the active page being capturable by the browser. Browser internal pages and protected pages cannot be captured.
- Local OCR recognizes text locally, but an explanation still needs a configured LLM provider.
- The public build is not a hosted account, billing, or team product.

## License

MIT, as declared by the Rust workspace. A repository-wide `LICENSE` file has not yet been added.
