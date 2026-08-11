const fs = require("node:fs");
const { chromium } = require("playwright");

async function main() {
  const extensionPath = process.env.TERMPOP_EXTENSION_PATH;
  const profilePath = process.env.TERMPOP_PROFILE_PATH;
  const fixtureUrl = process.env.TERMPOP_FIXTURE_URL;
  const screenshotPath = process.env.TERMPOP_SCREENSHOT_PATH;

  if (!extensionPath || !profilePath || !fixtureUrl) {
    throw new Error("Missing TermPop layout E2E environment variables.");
  }

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "msedge",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
    ],
  });

  try {
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      workers = [await context.waitForEvent("serviceworker", { timeout: 15_000 })];
    }

    const extensionId = new URL(workers[0].url()).host;
    const page = await context.newPage();
    await page.goto(fixtureUrl);

    const before = await measure(page);
    if (process.env.TERMPOP_PREGRANTED === "1") {
      await page.bringToFront();
      const activation = await workers[0].evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
          throw new Error("The layout fixture tab is unavailable.");
        }
        const url = new URL(tab.url);
        const originPattern = `${url.protocol}//${url.host}/*`;
        const stored = await chrome.storage.local.get("termpop.blockedOrigins");
        const blockedOrigins = Array.isArray(stored["termpop.blockedOrigins"])
          ? stored["termpop.blockedOrigins"].filter((origin) => origin !== originPattern)
          : [];
        await chrome.storage.local.set({ "termpop.blockedOrigins": blockedOrigins });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-loader.js"],
        });
        return { tabId: tab.id, originPattern };
      });
      if (!activation.tabId) {
        throw new Error(`Failed to activate fixture: ${JSON.stringify(activation)}`);
      }
    } else {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/assets/popup.html`);
      await popup.locator("#site-access-toggle").click({ timeout: 10_000 });
    }

    await page.bringToFront();
    await page.waitForSelector("#hostile .termpop-highlight", { timeout: 20_000 });
    await page.waitForTimeout(600);
    const after = await measure(page);

    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    const result = {
      before,
      after,
      stable:
        Math.abs(before.width - after.width) < 0.5 &&
        Math.abs(before.height - after.height) < 0.5 &&
        Math.abs(before.flexHeight - after.flexHeight) < 0.5 &&
        after.highlights >= 3 &&
        after.flexHighlights === 0 &&
        after.displays.every((display) => display === "inline"),
    };

    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.stable) {
      process.exitCode = 2;
    }
  } finally {
    await context.close();
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const paragraph = document.querySelector("#hostile").getBoundingClientRect();
    const flexCopy = document.querySelector("#flex-copy").getBoundingClientRect();
    const highlights = Array.from(
      document.querySelectorAll("#hostile .termpop-highlight"),
    );

    return {
      width: paragraph.width,
      height: paragraph.height,
      flexHeight: flexCopy.height,
      highlights: highlights.length,
      flexHighlights: document.querySelectorAll("#flex-copy .termpop-highlight").length,
      displays: highlights.map((element) => getComputedStyle(element).display),
    };
  });
}

main().catch((error) => {
  fs.writeSync(process.stderr.fd, `${error.stack ?? error}\n`);
  process.exitCode = 1;
});
