// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture the locale & units settings panel (imperial preview).
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://127.0.0.1:4180";
const OUT = (process.env.OUT ?? new URL("./out", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("acs.call", "OE8APR"));
const page = await ctx.newPage();
await page.goto(`${BASE}/#12/47.07/15.44`, { waitUntil: "load" });
await page.waitForSelector(".splash", { state: "detached", timeout: 25000 });
await page.waitForTimeout(900);
await page.click("button[title^='Settings']");
await page.waitForSelector(".panel.right h2", { timeout: 8000 });
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + "09-settings-metric.png" });
console.log("09-settings-metric");
await page.click(".panel.right button:has-text('Imperial')");
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + "10-settings-imperial.png" });
console.log("10-settings-imperial");
await ctx.close();
await browser.close();
console.log("settings shoot complete ->", OUT);
