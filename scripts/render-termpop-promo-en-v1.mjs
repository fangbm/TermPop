import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/方便面/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")), "..");
const htmlPath = path.join(repoRoot, "scripts", "termpop-promo-en-v1.html");
const framesDir = path.join(repoRoot, "artifacts", "promo-en-v1-frames");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const fps = Number(process.env.TERMPOP_PROMO_FPS || 30);
const duration = Number(process.env.TERMPOP_PROMO_DURATION || 60);
const frameCount = Math.ceil(fps * duration);

await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(framesDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none"],
});

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

for (let frame = 0; frame < frameCount; frame += 1) {
  const time = frame / fps;
  await page.evaluate((value) => window.renderAt(value), time);
  const filename = `frame-${String(frame).padStart(5, "0")}.jpg`;
  await page.screenshot({ path: path.join(framesDir, filename), type: "jpeg", quality: 95 });
  if (frame % fps === 0) process.stdout.write(`Rendered ${Math.floor(time)}s / ${duration.toFixed(1)}s\n`);
}

await browser.close();
process.stdout.write(`Rendered ${frameCount} frames to ${framesDir}\n`);
