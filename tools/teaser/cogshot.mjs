// Capture the Cogmind (ASCII/CP437) flip on hardware-free demo surfaces.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = (process.env.OUT ?? new URL("./cog", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function shoot(demo, theme, file) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((th) => {
    localStorage.setItem("acs.call", "OE8APR");
    localStorage.setItem("acs.locale", JSON.stringify({ theme: th }));
  }, theme);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${demo}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + file });
  console.log(file);
  await ctx.close();
}

await shoot("app-packet", "cogmind", "packet-cogmind.png");
await shoot("app-packet", "modern", "packet-modern.png");
await shoot("app-bbs", "cogmind", "bbs-cogmind.png");
await shoot("app-remote", "cogmind", "remote-cogmind.png");

await browser.close();
