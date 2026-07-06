# TermPop Site

Product website for TermPop, built with React 19 and Vite.

## Local development

```powershell
npm ci
npm run dev
```

## Build

```powershell
npm run typecheck
npm run build
```

## Cloudflare Pages

Recommended Pages settings:

- Root directory: `apps/termpop-site`
- Build command: `npm ci && npm run build`
- Build output directory: `dist`

Optional environment variables:

- `VITE_CHROME_STORE_URL`
- `VITE_EDGE_ADDONS_URL`

When store URLs are not configured, the site shows the GitHub Releases download link.
