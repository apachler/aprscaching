// Compose the brand teaser poster from the captured screenshots.
import { chromium } from "playwright";
const OUT = (process.env.OUT ?? new URL("./out", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 2 });
await page.goto("file://" + OUT + "teaser.html", { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + "teaser.png", fullPage: true });
await browser.close();
console.log("teaser ->", OUT + "teaser.png");
