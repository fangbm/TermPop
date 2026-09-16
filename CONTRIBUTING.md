# Contributing to TermPop

Thanks for your interest in improving TermPop.

## Before You Start

For larger changes, please open an issue first so the proposed behavior and scope can be discussed before implementation. Small bug fixes, tests, documentation improvements, and focused compatibility fixes can usually go directly to a pull request.

## Development Setup

TermPop uses a Rust core compiled to WebAssembly together with a Manifest V3 browser extension.

Requirements:

- Rust stable
- Node.js 22 or newer
- `wasm-pack`

Run the core checks and build the WASM package:

```bash
cargo test --workspace
wasm-pack build crates/termpop-core --target web --out-dir ../../extension/src/wasm -- --features wasm
```

Then check the extension:

```bash
cd extension
npm ci
npm run typecheck
npm test
npm run build
```

For the product site:

```bash
cd apps/termpop-site
npm ci
npm run typecheck
npm run build
```

## Pull Requests

Please keep pull requests focused and explain:

- what problem the change solves;
- the approach taken;
- how the change was tested;
- any browser, permission, privacy, or security implications.

Add or update tests for behavior changes whenever practical. Avoid unrelated formatting or refactoring in the same pull request.

## Security Issues

Do not report vulnerabilities publicly. Follow the instructions in [SECURITY.md](SECURITY.md).

## Code of Conduct

Be respectful and constructive. Focus discussion on the code, behavior, and technical tradeoffs.
