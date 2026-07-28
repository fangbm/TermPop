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

Download links are selected from the browser user agent:

- Microsoft Edge opens the official [TermPop Edge Add-ons listing](https://microsoftedge.microsoft.com/addons/detail/termpop/blphbffphknkkblackimhnjbckegnchn).
- Other browsers open the latest [GitHub Release](https://github.com/fangbm/TermPop/releases/latest).
