// SPDX-License-Identifier: AGPL-3.0-or-later
import { chromium } from "playwright";
const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const p = await (await b.newContext({ viewport: { width: 400, height: 120 }, deviceScaleFactor: 2 })).newPage();
await p.goto("http://127.0.0.1:8802/badge/OE8APR.svg", { waitUntil: "load" });
await p.waitForTimeout(400);
await p.screenshot({ path: new URL("./out/12-badge.png", import.meta.url).pathname });
await b.close();
console.log("badge shot done");
