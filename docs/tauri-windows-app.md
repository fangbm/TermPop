# TermLens Tauri Windows App

This app is the Tauri replacement path for the earlier egui Windows prototype.

## Scope

- A regular `settings` window controls capture behavior.
- A transparent, always-on-top `overlay` window draws highlights at UI Automation text rectangles.
- The overlay is mouse-pass-through by default, so source applications remain clickable.
- Rust commands reuse `termlens-core` and the existing Windows UI Automation capture pipeline.
- The first version auto-shows the explanation for the first detected term near the source rectangle.

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

## Current Limits

- The overlay depends on UI Automation `TextPattern` rectangles. Apps that do not expose TextPattern may only provide text without exact term rectangles.
- Hover interaction over the original term is not enabled yet because the overlay is mouse-pass-through by default.
- The capture module is temporarily reused from `apps/termlens-windows`; it should be extracted into a shared Rust crate once the Tauri path stabilizes.
