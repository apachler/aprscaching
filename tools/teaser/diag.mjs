// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const EXE = process.env.PW_CHROMIUM;
const V =
  process.env.VIEW === "tablet"
    ? { w: 834, h: 1112, dsf: 1 }
    : process.env.VIEW === "mobile"
      ? { w: 390, h: 844, dsf: 2 }
      : { w: 1440, h: 900, dsf: 1 };
console.log("launch", process.env.VIEW, V);
const b = await chromium.launch({
  executablePath: EXE,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const ctx = await b.newContext({ viewport: { width: V.w, height: V.h }, deviceScaleFactor: V.dsf });
await ctx.addInitScript(() => {
  localStorage.setItem("acs.call", "OE8APR");
  sessionStorage.setItem("acs.explore", "1");
});
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
page.on("crash", () => console.log("  [PAGE CRASHED]"));
console.log("goto...");
await page.goto("http://127.0.0.1:4199/#11.5/47.078/15.43", { waitUntil: "load", timeout: 30000 });
console.log("loaded. waiting splash detach...");
await page
  .waitForSelector(".splash", { state: "detached", timeout: 25000 })
  .then(() => console.log("  splash gone"))
  .catch(() => console.log("  splash STILL up"));
await page
  .waitForSelector(".cache-pin,.beacon-pin", { timeout: 15000 })
  .then(() => console.log("  pins present"))
  .catch(() => console.log("  no pins"));
await page.waitForTimeout(1500);
await page.screenshot({ path: "tour/diag-" + process.env.VIEW + ".png" });
console.log("screenshot ok");
await ctx.close();
await b.close();
console.log("DIAG DONE");
