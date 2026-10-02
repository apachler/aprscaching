// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The landing page's images, made from the real app on the demo fixtures: the map band (the live map over the
 * real vector basemap, chrome hidden), a phone screenshot (a cache sheet), a desktop screenshot (Nearby beside a
 * cache) and the Open Graph card (the hero itself), plus the hero photo at three widths. Each is written to
 * apps/web/public/landing/ as AVIF and WebP by encode.py (Pillow), next to this file.
 *
 *   pnpm --filter @aprscaching/web build && node apps/web/test/visual/landing-assets.mjs
 *
 * The map band fetches OpenFreeMap tiles (the demo's `&net=1`), so it needs a connection; the band's caption on
 * the landing page carries their attribution.
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../..");
const DIST = path.join(WEB, "dist");
const RAW = path.join(HERE, "out/landing");
const PUBLIC = path.join(WEB, "public/landing");
const FIXED_NOW = new Date(Date.UTC(2026, 9, 1, 14, 30));

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
};
function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let file = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory())
        file = path.join(DIST, "index.html");
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Hide the app chrome so the map alone is in the frame. */
const MAP_ONLY = `.topbar,.rail,.tabbar,.maptools,.basemap-switch,.coordreadout,.maptools-bar,.maplibregl-control-container,.panel{display:none!important}`;

const SHOTS = [
  {
    name: "map-band",
    view: { width: 1600, height: 620 },
    scale: 1,
    theme: "light",
    url: "/?demo=app&as=user&net=1#14.4/47.0725/15.4410",
    css: MAP_ONLY,
    stations: true,
    settle: 6000,
  },
  {
    name: "phone",
    view: { width: 390, height: 844 },
    scale: 2,
    theme: "dark",
    url: "/?v=demo&demo=app&as=user&net=1",
    settle: 5000,
  },
  {
    name: "desktop",
    view: { width: 1280, height: 800 },
    scale: 1.5,
    theme: "dark",
    url: "/?view=nearby&demo=app&as=user&net=1#14.5/47.0725/15.4380",
    click: ".ccard >> nth=2",
    settle: 5000,
  },
  {
    name: "og",
    view: { width: 1200, height: 630 },
    scale: 1,
    theme: "dark",
    url: "/?demo=app&as=out",
    css: ".landing-nav-links{display:none!important}",
    settle: 2500,
  },
];

const exe = process.env.CHROMIUM_PATH || chromium.executablePath();
mkdirSync(RAW, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
for (const s of SHOTS) {
  const ctx = await browser.newContext({
    viewport: s.view,
    deviceScaleFactor: s.scale,
    locale: "en-US",
    serviceWorkers: "block",
  });
  await ctx.clock.setFixedTime(FIXED_NOW);
  await ctx.addInitScript(
    ([theme, stations]) => {
      localStorage.setItem("acs.tour.seen", "1");
      localStorage.setItem("acs.locale", JSON.stringify({ theme, units: "metric" }));
      if (stations) localStorage.setItem("acs.layer.stations", "1");
    },
    [s.theme, !!s.stations],
  );
  const page = await ctx.newPage();
  await page.goto(origin + s.url, { waitUntil: "networkidle", timeout: 60000 });
  if (s.click) await page.click(s.click, { timeout: 8000 });
  if (s.css) await page.addStyleTag({ content: s.css });
  await page.waitForTimeout(s.settle);
  await page.screenshot({ path: path.join(RAW, `${s.name}.png`) });
  console.log(`rendered ${s.name}`);
  await ctx.close();
}
await browser.close();
server.close();

execFileSync(
  "uvx",
  [
    "--from",
    "pillow>=11.3",
    "python",
    path.join(HERE, "encode.py"),
    RAW,
    PUBLIC,
    path.join(WEB, "public/brand/bg.jpg"),
  ],
  { stdio: "inherit" },
);
