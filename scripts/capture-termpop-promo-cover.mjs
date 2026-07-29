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
const anchorGeometry = await page.evaluate(() => {
  const term = document.querySelector(".term").getBoundingClientRect();
  const card = document.querySelector(".popover");
  const cardRect = card.getBoundingClientRect();
  const arrowLeft = Number.parseFloat(getComputedStyle(card, "::after").left);
  const termCenter = term.left + term.width / 2;
  const arrowCenter = cardRect.left + arrowLeft + 11.5;
  return { termCenter, arrowCenter, delta: Math.abs(termCenter - arrowCenter) };
});
if (anchorGeometry.delta > 1) {
  throw new Error(`Popover arrow is not aligned: ${JSON.stringify(anchorGeometry)}`);
}
console.log(`Popover anchor delta: ${anchorGeometry.delta.toFixed(2)}px`);
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

const page4x3 = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
await page4x3.goto(`${pathToFileURL(source).href}?ratio=4x3`, { waitUntil: "load" });
await page4x3.evaluate(() => document.fonts.ready);
const anchorGeometry4x3 = await page4x3.evaluate(() => {
  const term = document.querySelector(".term").getBoundingClientRect();
  const card = document.querySelector(".popover");
  const cardRect = card.getBoundingClientRect();
  const arrowLeft = Number.parseFloat(getComputedStyle(card, "::after").left);
  const termCenter = term.left + term.width / 2;
  const arrowCenter = cardRect.left + arrowLeft + 11.5;
  return { termCenter, arrowCenter, delta: Math.abs(termCenter - arrowCenter) };
});
if (anchorGeometry4x3.delta > 1) {
  throw new Error(`4:3 popover arrow is not aligned: ${JSON.stringify(anchorGeometry4x3)}`);
}
console.log(`4:3 popover anchor delta: ${anchorGeometry4x3.delta.toFixed(2)}px`);
await page4x3.screenshot({ path: path.join(output, "termpop-promo-cover-1600x1200.png") });
await page4x3.screenshot({
  path: path.join(output, "termpop-promo-cover-1600x1200.jpg"),
  type: "jpeg",
  quality: 95,
});

await browser.close();
