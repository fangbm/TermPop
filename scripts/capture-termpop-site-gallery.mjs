import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/方便面/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.env.TERMPOP_SITE_URL || "http://127.0.0.1:4173";
const output = path.join(root, "apps", "termpop-site", "public", "store-assets");

await fs.mkdir(output, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--hide-scrollbars", "--font-render-hinting=none"]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

async function capture(url, outputName, selector) {
  await page.goto(`${baseUrl}${url}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (selector) {
    await page.locator(selector).scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(output, outputName), type: "png" });
}

await capture("/demo?lang=en", "producthunt-gallery-interactive-demo-en-1280x800.png", ".demo-surface");
await page.locator(".demo-surface .termpop-highlight").first().hover();
await page.waitForTimeout(520);
await page.screenshot({
  path: path.join(output, "producthunt-gallery-hover-explanation-en-1280x800.png"),
  type: "png"
});

await capture("/?lang=en#features", "producthunt-gallery-reading-tools-en-1280x800.png", "#features");

await browser.close();
console.log(`Created gallery assets in ${output}`);
