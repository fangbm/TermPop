import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/方便面/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const root = path.resolve(import.meta.dirname, "..");
const source = path.resolve(import.meta.dirname, "termpop-promo-en-v1.html");
const output = path.resolve(root, process.env.TERMPOP_STILLS_DIR || "artifacts/promo-en-v1-stills");
const times = (process.env.TERMPOP_STILL_TIMES || "3.8,8.5,10.8,13.2,19.8,21.2,23.4,30.4,33.9,39.8,42.9,47.8,50.6,56.5,59.5")
  .split(",")
  .map(Number)
  .filter(Number.isFinite);

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--allow-file-access-from-files", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

for (const time of times) {
  await page.evaluate((value) => window.renderAt(value), time);
  await page.screenshot({ path: path.join(output, `frame-${time.toFixed(2).replace(".", "-")}.png`) });
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return {
      hoverTerm: rect("#s2Mark"),
      hoverCard: rect("#s2Popover"),
      hoverCursor: rect("#s2Cursor"),
      selection: rect(".selection-wrap"),
      contextMenu: rect("#s3Menu"),
      selectionCard: rect("#s3Popover"),
      selectionCursor: rect("#s3Cursor"),
      pdfTerm: rect(".pdf-term"),
      pdfCard: rect("#s4Popover"),
      cacheWindow: rect("#s5Window"),
      cacheResult: rect("#s5Result"),
    };
  });
  console.log(JSON.stringify({ time, geometry }));
}

await browser.close();
