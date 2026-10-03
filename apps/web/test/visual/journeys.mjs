// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The journeys walk: the main tasks of the app, done the way a person does them (the visible controls, by
 * their names), on the demo fixtures, at phone and desktop size. Each step leaves a screenshot in
 * out/journeys/<journey>-<view>-<n>-<step>.png and a line in out/journeys/log.txt; a step that cannot find
 * its control is recorded, not fatal, because a control nobody can find is the finding.
 *
 *   pnpm --filter @aprscaching/web build && node apps/web/test/visual/journeys.mjs [--only find,hide]
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist");
const OUT = path.join(HERE, "out/journeys");
const VIEWS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800 },
};

/** Each journey: who, where it starts, and its steps — [what, how]. `how` is "click:<role>:<name>",
 *  "fill:<label>:<text>" or "key:<key>"; "a||b" tries the names in turn (the phone's tab bar says "Log" where
 *  the desktop panel says "Log a find"). Names match the way a person reads the screen. A third element lists the
 *  views a step belongs to, for a step only one layout needs (More, on a phone). */
const JOURNEYS = [
  {
    name: "first-visit",
    as: "out",
    start: "/",
    steps: [
      ["Landing", null],
      ["Explore the map", "click:link|button:Explore the live map"],
      ["The tour", null],
      ["Skip the tour", "click:button:Skip"],
    ],
  },
  {
    name: "sign-in",
    as: "out",
    start: "/",
    steps: [
      ["Landing", null],
      ["Sign in", "click:link|button:Sign in with your callsign"],
      ["Enter a call", "fill:Callsign:OE8APR"],
    ],
  },
  {
    name: "find-and-log",
    as: "user",
    start: "/",
    steps: [
      ["Map", null],
      ["Open Nearby", "click:button:Nearby"],
      ["Pick the nearest cache", "click:button:The Landhaus courtyard"],
      ["Navigate", "click:button:Navigate"],
      ["Find", "click:button:Find"],
      ["Log a find", "click:button:Log a find||Log"],
      ["The result", null],
    ],
  },
  {
    name: "hide",
    as: "user",
    start: "/",
    steps: [
      ["Map", null],
      ["Hide a cache", "click:button:Hide"],
      ["The form", null],
    ],
  },
  {
    name: "settings-search",
    as: "user",
    start: "/?view=settings",
    steps: [
      ["Settings", null],
      ["Search for units", "fill:Search settings:units"],
    ],
  },
  {
    name: "shack",
    as: "user",
    start: "/",
    steps: [
      ["Map", null],
      ["More", "click:button:More", ["phone"]],
      ["Open the Shack", "click:button:Shack"],
      ["Launch the BBS", "click:button:BBS"],
      ["Back", "key:Escape"],
    ],
  },
  {
    name: "sysop-first-hour",
    as: "sysop",
    start: "/?view=admin",
    steps: [["Instance admin, Setup", null]],
  },
];

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* none */
  }
  return null;
}

function serve() {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
  };
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

async function act(page, how) {
  const [kind, a, b] = how.split(":");
  if (kind === "key") return page.keyboard.press(a);
  if (kind === "fill") return page.getByLabel(a, { exact: false }).first().fill(b, { timeout: 5000 });
  const roles = a.split("|");
  // an open modal dialog is all a person can reach: look there first
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').last();
  const scope = (await dialog.count()) ? dialog : page;
  for (const name of b.split("||")) {
    for (const role of roles) {
      const loc = scope.getByRole(role, { name, exact: name.length <= 4 }).first();
      if (await loc.count()) return loc.click({ timeout: 5000 });
    }
  }
  throw new Error(`no ${a} named "${b}"`);
}

const exe = findChromium();
if (!exe) {
  console.log("SKIP journeys: no Chromium");
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const log = [];
for (const j of JOURNEYS) {
  if (only && !only.includes(j.name)) continue;
  for (const [view, vp] of Object.entries(VIEWS)) {
    const ctx = await browser.newContext({
      viewport: vp,
      ...vp,
      locale: "en-US",
      serviceWorkers: "block",
      geolocation: { latitude: 47.0704, longitude: 15.4393 },
      permissions: ["geolocation"],
    });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.clock.setFixedTime(new Date(Date.UTC(2026, 9, 1, 14, 30)));
    if (j.name !== "first-visit") await ctx.addInitScript(() => localStorage.setItem("acs.tour.seen", "1"));
    const page = await ctx.newPage();
    const sep = j.start.includes("?") ? "&" : "?";
    await page.goto(`${origin}${j.start}${sep}demo=app&as=${j.as}#14/47.0725/15.4380`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    let n = 0;
    for (const [step, how, views] of j.steps) {
      if (views && !views.includes(view)) continue; // a step only one layout needs, such as More on a phone
      n++;
      let note = "ok";
      if (how) {
        try {
          await act(page, how);
          await page.waitForTimeout(700);
        } catch (e) {
          note = `STUCK: ${String(e.message).split("\n")[0]}`;
        }
      }
      const file = `${j.name}-${view}-${n}-${step.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
      await page.screenshot({ path: path.join(OUT, file) });
      log.push(`${j.name}\t${view}\t${n}\t${step}\t${note}\t${file}`);
      console.log(`${j.name.padEnd(18)} ${view.padEnd(8)} ${n}. ${step.padEnd(26)} ${note}`);
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
writeFileSync(path.join(OUT, "log.txt"), log.join("\n") + "\n");
