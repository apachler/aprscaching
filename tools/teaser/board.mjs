// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture the M4 community leaderboard + a profile card (desktop).
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = (process.env.OUT ?? new URL("./out", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("acs.call", "OE8APR"));
const page = await ctx.newPage();

await page.goto(`${BASE}/#12/47.083/15.423`, { waitUntil: "load" });
await page.waitForSelector(".splash", { state: "detached", timeout: 25000 });
await page.waitForSelector(".cache-pin, .beacon-pin", { timeout: 15000 });
await page.waitForTimeout(1200);

// open the leaderboard
await page.click("button[title='Leaderboard']");
await page.waitForSelector(".panel.right .board", { timeout: 8000 });
await page.waitForTimeout(900);
await page.screenshot({ path: OUT + "05-leaderboard.png" });
console.log("05-leaderboard");

// open a profile by clicking the top logger
await page.click(".panel.right .board button.link");
await page.waitForTimeout(900);
await page.screenshot({ path: OUT + "06-profile.png" });
console.log("06-profile");

await ctx.close();
await browser.close();
console.log("board shoot complete ->", OUT);
