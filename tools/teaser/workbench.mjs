// Capture the M5 workbench: live stations layer + packet decoder + station inspector.
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
await page.waitForTimeout(1000);

// open the workbench
await page.click("button[title^='Workbench']");
await page.waitForSelector(".panel.right h2", { timeout: 8000 });
// turn on the live stations layer
await page.click(".panel.right input[type=checkbox]");
await page.waitForSelector(".station-pin", { timeout: 8000 });
await page.waitForTimeout(800);
// decode a sample packet
await page.click(".panel.right button.link"); // "use a sample"
await page.click(".panel.right button.primary"); // Decode
await page.waitForSelector(".decoded", { timeout: 8000 });
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + "07-workbench.png" });
console.log("07-workbench");

// click a moving station pin to open its inspector
await page.click(".station-pin");
await page.waitForTimeout(700);
await page.screenshot({ path: OUT + "08-station.png" });
console.log("08-station");

await ctx.close();
await browser.close();
console.log("workbench shoot complete ->", OUT);
