/**
 * Reference: ContactOut cross-match + 429 backoff (Node.js / Playwright).
 * NOT wired to production — see Playwright/README.md
 *
 * Usage:
 *   npm init -y && npm i playwright
 *   node examples/nodejs/cross_match_reveal.mjs "Ryan Cronin" "https://linkedin.com/in/..."
 */

import { chromium } from "playwright";

const humanWait = (min = 3000, max = 7000) =>
  new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));

function cleanLinkedIn(url) {
  return (url || "").split("?")[0].toLowerCase().replace(/\/$/, "");
}

async function gotoWithRetry(page, url, maxAttempts = 5) {
  let backoff = 5000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await humanWait();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (response?.status() === 429) {
      console.warn(`[429] Backing off ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff *= 2;
      continue;
    }
    return response;
  }
  throw new Error(`429 loop on ${url}`);
}

async function verifyCredits(page) {
  const body = await page.innerText("body");
  const match = body.match(/(\d+)\s*credits?\s*(left|remaining)/i);
  if (match) return parseInt(match[1], 10);
  return 999;
}

async function crossMatchAndReveal(targetName, expectedLinkedIn) {
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    // proxy: { server: process.env.CONTACTOUT_PROXY_URL },
  });

  const context = await browser.newContext({
    storageState: process.env.CONTACTOUT_SESSION_FILE,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await gotoWithRetry(page, "https://contactout.com/dashboard/search");
    const credits = await verifyCredits(page);
    if (credits <= 0) {
      console.error("Credits depleted — stopping");
      return;
    }

    const nameInput = page.getByLabel("Name").first();
    await nameInput.click();
    await nameInput.fill(targetName);
    await nameInput.press("Enter");
    await humanWait(3000, 6000);
    await page.mouse.wheel(0, 400);

    const cards = await page.locator("table tbody tr, .profile-card").all();
    const expected = cleanLinkedIn(expectedLinkedIn);

    for (const card of cards) {
      const anchor = card.locator('a[href*="linkedin.com"]').first();
      if ((await anchor.count()) === 0) continue;
      const found = cleanLinkedIn(await anchor.getAttribute("href"));
      if (found !== expected) continue;

      console.log("LinkedIn verified — scoped reveal");
      const reveal = card.getByRole("button", { name: /reveal|show email/i });
      await humanWait(1500, 3500);
      await reveal.first().click();
      break;
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

const [, , name, linkedin] = process.argv;
if (!name || !linkedin) {
  console.error("Usage: node cross_match_reveal.mjs <name> <linkedin_url>");
  process.exit(1);
}
crossMatchAndReveal(name, linkedin);
