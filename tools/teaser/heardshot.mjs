// SPDX-License-Identifier: AGPL-3.0-or-later
// Illustrate the mheard-tool ↔ terminal-Monitor overlap: capture channel-0 Monitor and the mheard panel.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = (process.env.OUT ?? new URL("./cog", import.meta.url).pathname).replace(/\/?$/, "/");
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function shot(demo, file) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    localStorage.setItem("acs.call", "OE8APR");
    localStorage.setItem("acs.locale", JSON.stringify({ theme: "cogmind" }));
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  // switch the central window to channel 0 (Monitor) so heard traffic renders + feeds the colourisers
  await page
    .getByRole("tab", { name: /Monitor/ })
    .click()
    .catch(() => {});
  await page.waitForTimeout(2500); // let the 1s poll re-render the mheard panel from the store
  await page.screenshot({ path: OUT + file });
  console.log(file);
  await ctx.close();
}

await shot("app-packet", "overlap-terminal-monitor.png");
await shot("app-packet-tools", "overlap-mheard-tool.png");
await browser.close();
