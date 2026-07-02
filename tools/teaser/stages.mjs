// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:1440,height:980}, deviceScaleFactor:2 });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4181/#15/47.073/15.437", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForTimeout(1200);
// open the staged cache directly via its pin
await p.evaluate(() => { const els=[...document.querySelectorAll("button.cache-pin")]; (els.find(e=>(e.title||"").includes("Audio")) || els[0])?.click(); });
await p.waitForSelector(".panel.right .stages", { timeout:8000 });
await p.waitForTimeout(600);
await p.screenshot({ path: new URL("./out/13-audio-cache.png", import.meta.url).pathname });
console.log("audio-cache shot done");
await b.close();
