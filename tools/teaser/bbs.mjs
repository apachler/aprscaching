// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4182/#12/47.07/15.44", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForTimeout(900);
await p.click("button[title^='BBS']");
await p.waitForSelector(".panel.right .logs", { timeout:8000 });
await p.waitForTimeout(500);
await p.screenshot({ path: new URL("./out/14-bbs-inbox.png", import.meta.url).pathname });
console.log("14-bbs-inbox");
await p.click(".panel.right button:has-text('Bulletins')");
await p.waitForTimeout(500);
await p.screenshot({ path: new URL("./out/15-bbs-bulletins.png", import.meta.url).pathname });
console.log("15-bbs-bulletins");
await b.close();
