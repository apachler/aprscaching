import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport:{width:1280,height:800}, deviceScaleFactor:2 });
await ctx.addInitScript(() => localStorage.setItem("acs.call","OE8APR"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4185/#13/47.05/15.43", { waitUntil:"load" });
await p.waitForSelector(".splash", { state:"detached", timeout:25000 });
await p.waitForSelector(".cache-pin", { timeout:15000 });
await p.waitForTimeout(1000);
const shot = async (n) => { await p.waitForTimeout(500); await p.screenshot({ path: new URL(`./out/${n}.png`, import.meta.url).pathname }); console.log(n); };
// Activity
await p.click("button:has-text('Activity')"); await p.waitForSelector(".panel.right h2"); await shot("19-activity");
// Profile
await p.click("button[title^='Profile']"); await p.waitForSelector(".panel.right h2"); await shot("20-profile");
// Nearby
await p.click("button:has-text('Nearby')"); await p.waitForSelector(".panel.right h2"); await shot("21-nearby");
// Cache detail = one-tap log: close nearby, click a pin
await p.click(".panel.right .icon");
await p.evaluate(() => { const e=[...document.querySelectorAll("button.cache-pin")]; e[0]?.click(); });
await p.waitForSelector(".logform", { timeout:8000 }); await shot("22-onetap-log");
await b.close();
