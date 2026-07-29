import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/方便面/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = path.resolve(import.meta.dirname, "..");
const source = path.resolve(import.meta.dirname, "termpop-promo-cover.html");
const output = path.resolve(root, "artifacts");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--allow-file-access-from-files", "--disable-gpu-sandbox", "--font-render-hinting=none"],
});

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(output, "termpop-promo-cover-1920x1080.png") });
await page.screenshot({
  path: path.join(output, "termpop-promo-cover-1920x1080.jpg"),
  type: "jpeg",
  quality: 95,
});

await page.setViewportSize({ width: 1280, height: 720 });
await page.evaluate(() => {
  document.documentElement.style.transformOrigin = "0 0";
  document.documentElement.style.transform = "scale(0.6666666667)";
});
await page.screenshot({ path: path.join(output, "termpop-promo-cover-1280x720.png") });

await browser.close();
