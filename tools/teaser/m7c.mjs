// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:1200,height:720}, deviceScaleFactor:1.5, geolocation:{latitude:47.05,longitude:15.43}, permissions:["geolocation"] });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4187/#12/47.05/15.43", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForSelector(".cache-pin", { timeout:15000 });
await p.waitForTimeout(1000);
await p.evaluate(() => { const e=[...document.querySelectorAll("button.cache-pin")]; e[0]?.click(); });
await p.waitForSelector(".logform", { timeout:8000 });
await ctx.setOffline(true);
await p.click(".logform button.primary");
await p.waitForSelector(".logresult", { timeout:12000 });
await p.waitForTimeout(400);
await p.screenshot({ path: new URL("./out/27-offline-queue.png", import.meta.url).pathname });
console.log("27 done");
await b.close();
