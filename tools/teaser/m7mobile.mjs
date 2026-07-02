// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4186/#13/47.03/15.43", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForSelector(".cache-pin", { timeout:15000 });
await p.waitForTimeout(1000);
const shot = async (n) => { await p.waitForTimeout(500); await p.screenshot({ path: new URL(`./out/${n}.png`, import.meta.url).pathname }); console.log(n); };
await shot("23-mobile-map");
// open a cache detail -> bottom sheet + FAB reads "Log"
await p.evaluate(() => { const e=[...document.querySelectorAll("button.cache-pin")]; e[0]?.click(); });
await p.waitForSelector(".panel", { timeout:8000 }); await shot("24-mobile-sheet");
// Nearby via tab bar
await p.click(".tabbar button:has-text('Nearby')"); await p.waitForSelector(".panel h2"); await shot("25-mobile-nearby");
await b.close();
