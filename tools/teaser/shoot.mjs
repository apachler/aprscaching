// SPDX-License-Identifier: AGPL-3.0-or-later
// Crawl the running app and capture the page states (desktop + mobile).
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = (process.env.OUT ?? new URL("./out", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined; // unset => Playwright resolves its own
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function newCtx(width, height, dsf = 2) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf });
  await ctx.addInitScript(() => localStorage.setItem("acs.call", "OE8APR"));
  return ctx;
}
async function ready(page) {
  await page.waitForSelector(".splash", { state: "detached", timeout: 25000 });
  await page.waitForSelector(".cache-pin, .beacon-pin", { timeout: 15000 });
  await page.waitForTimeout(1200);
}
async function clickCache(page, match) {
  await page.evaluate((m) => {
    const els = [...document.querySelectorAll("button.cache-pin, img.beacon-pin")];
    (els.find((e) => (e.title || "").includes(m)) || els[0])?.click();
  }, match);
  await page.waitForSelector(".panel.right", { timeout: 8000 });
  await page.waitForTimeout(700);
}

// 01 map overview + 02 detail
{
  const ctx = await newCtx(1440, 900);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#11.6/47.083/15.423`, { waitUntil: "load" });
  await ready(page);
  await page.screenshot({ path: OUT + "01-map.png" });
  console.log("01-map");
  await clickCache(page, "Schlossberg");
  await page.screenshot({ path: OUT + "02-detail.png" });
  console.log("02-detail");
  await ctx.close();
}
// 03 hide a cache
{
  const ctx = await newCtx(1440, 900);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#13/47.0735/15.4378`, { waitUntil: "load" });
  await ready(page);
  await page.click("button.primary:has-text('Hide a cache')");
  await page.waitForSelector(".panel.left", { timeout: 6000 });
  await page.locator(".maplibregl-canvas").click({ position: { x: 760, y: 360 } });
  await page.waitForTimeout(500);
  await page.fill('.panel.left label:has-text("Title") input', "Castle Casemates").catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + "03-hide.png" });
  console.log("03-hide");
  await ctx.close();
}
// 04 mobile detail
{
  const ctx = await newCtx(390, 844, 3);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#13/47.0735/15.4378`, { waitUntil: "load" });
  await ready(page);
  await clickCache(page, "Schlossberg");
  await page.screenshot({ path: OUT + "04-mobile.png" });
  console.log("04-mobile");
  await ctx.close();
}
await browser.close();
console.log("shoot complete ->", OUT);
