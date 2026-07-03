// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture the M6 workbench Network section: transports + TAK/CoT feed + messages.
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://127.0.0.1:4180";
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
await page.goto(`${BASE}/#12/47.07/15.44`, { waitUntil: "load" });
await page.waitForSelector(".splash", { state: "detached", timeout: 25000 });
await page.waitForTimeout(900);
await page.click("button[title^='Workbench']");
await page.waitForSelector(".panel.right h2", { timeout: 8000 });
await page.click(".panel.right input[type=checkbox]");
await page.waitForTimeout(700);
// scroll the panel down to reveal Transports / TAK feed / messages
await page.$eval(".panel.right", (el) => {
  el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + "11-m6-network.png" });
console.log("11-m6-network");
await ctx.close();
await browser.close();
console.log("m6 shoot complete ->", OUT);
