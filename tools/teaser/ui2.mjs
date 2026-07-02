// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:1100,height:720}, deviceScaleFactor:1.6 });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4188/#12/47.06/15.44", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForTimeout(900);
await p.click("button[title^='Profile']");
await p.waitForSelector(".panel.right .group");
await p.click(".group-toggle:has-text('Advanced')");
await p.waitForTimeout(300);
await p.click("button:has-text('⚙ Settings')");
await p.waitForSelector(".panel.right .srch");
await p.waitForTimeout(400);
await p.screenshot({ path: new URL("./out/30-settings-grouped.png", import.meta.url).pathname });
console.log("30 done");
await b.close();
