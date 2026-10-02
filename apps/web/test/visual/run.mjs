// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The visual and accessibility harness: renders the app's surfaces against the demo fixtures
 * (src/demo/fixtures.ts, `/?demo=app`) in the dark, light and Phosphor themes at a phone (390×844) and a
 * desktop (1280×800) viewport, saves a screenshot of each, runs axe-core (WCAG 2.0–2.2 A/AA) on each, and
 * writes an HTML index beside them. Nothing leaves the machine: the built app is served locally and every
 * third-party request is refused.
 *
 *   pnpm --filter @aprscaching/web build
 *   node apps/web/test/visual/run.mjs [--only map,detail] [--themes dark,light] [--views phone] [--no-shots]
 *
 * Output: apps/web/test/visual/out/ (gitignored): <surface>-<theme>-<view>.png, axe.json, index.html.
 * It exits non-zero when axe reports a serious or critical violation that is not in ALLOW below, so a CI job
 * can run it; screenshots are evidence for review, never compared pixel by pixel.
 * Browser: $CHROMIUM_PATH, else playwright-core's registry (`pnpm exec playwright-core install chromium`).
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist");
const OUT = path.join(HERE, "out");
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

/** axe rules allowed to fail, each with the reason; keep it short and dated. */
const ALLOW = new Map([
  // MapLibre's canvas and its attribution control are third-party markup the app does not render
  ["region:.maplibregl-ctrl-attrib", "MapLibre's attribution control sits outside the app's landmarks"],
  [
    "target-size:summary",
    "MapLibre's compact attribution toggle is 24×24 (styles/surfaces/map.css); axe flags it while MapLibre is still laying the control out",
  ],
]);

const VIEWS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800 },
};
const THEMES = ["dark", "light", "phosphor"];

/**
 * The surfaces: a persona, a query, and the steps that open it. `wait` is a selector that shows the surface
 * is up. Opening a surface uses the app's own deep links (?view=) or its own controls, like a person would.
 */
const SURFACES = [
  { name: "landing", as: "out", query: "", wait: ".landing" },
  {
    name: "signin",
    as: "out",
    query: "",
    wait: ".landing",
    steps: [["click", "text=/^Sign in/i"]],
    after: "form, .signin",
  },
  { name: "map", as: "user", query: "", wait: ".topbar" },
  // the top bar's search field from 960px up; narrower screens open it in a sheet from the search button
  {
    name: "search",
    as: "user",
    query: "",
    views: ["desktop"],
    wait: ".topbar",
    steps: [["fill", ".topsearch input", "Schloss"]],
    after: ".search-pop",
  },
  {
    name: "search-sheet",
    as: "user",
    query: "",
    views: ["phone"],
    wait: ".topbar",
    steps: [
      ["click", ".search-ic"],
      ["fill", ".in-sheet .topsearch input", "Schloss"],
    ],
    after: ".in-sheet .search-pop",
  },
  // the phone's More sheet: every destination the rail has that is not a tab
  {
    name: "more",
    as: "user",
    query: "",
    views: ["phone"],
    wait: ".tabbar",
    steps: [["click", ".tabbar button[aria-haspopup=dialog]"]],
    after: ".more-list",
  },
  {
    name: "detail",
    as: "user",
    query: "?view=nearby",
    wait: ".ccard",
    steps: [["click", ".ccard >> nth=0"]],
    after: ".detail-meta",
  },
  // the owner's edit form, with its stages, from the cache the persona hid
  {
    name: "edit",
    as: "user",
    query: "?view=nearby",
    wait: ".ccard",
    steps: [
      ["click", ".ccard:has-text('Schlossberg')"],
      ["click", "button[title^='Edit']"],
    ],
    after: ".stage-edit-list",
  },
  { name: "nearby", as: "user", query: "?view=nearby" },
  { name: "hide", as: "user", query: "?view=hide" },
  // the first-run tour: it starts when a visitor explores the map, with the tour not yet seen
  {
    name: "tour",
    as: "out",
    query: "",
    tour: true,
    wait: ".landing",
    steps: [["click", "text=Explore the live map"]],
    after: "[role=dialog]",
  },
  { name: "activity", as: "user", query: "?view=activity" },
  { name: "messages", as: "user", query: "?view=messages" },
  { name: "ranks", as: "user", query: "?view=ranks" },
  { name: "profile", as: "user", query: "?view=profile" },
  { name: "settings", as: "user", query: "?view=settings" },
  { name: "offline", as: "user", query: "?view=offline" },
  { name: "shack", as: "user", query: "?view=shack" },
  { name: "terminal", as: "user", query: "?view=terminal" },
  { name: "bbs", as: "user", query: "?view=bbs" },
  { name: "decoder", as: "user", query: "?view=decoder" },
  { name: "tools", as: "user", query: "?view=tools" },
  { name: "rig", as: "user", query: "?view=rig" },
  { name: "station", as: "user", query: "?view=station&call=OE6XRR-9" },
  { name: "docs", as: "user", query: "?view=docs&doc=index" },
  { name: "admin", as: "sysop", query: "?view=admin" },
  { name: "node", as: "sysop", query: "?view=node" },
  { name: "remote", as: "sysop", query: "?view=remote" },
  { name: "ui", as: "user", url: "/?demo=ui", wait: "main", fullPage: true },
  { name: "packet-harness", as: "user", url: "/?demo=packet", wait: "body" },
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]?.split(",") : null;
}

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* no registry browser */
  }
  return null;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
};

function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory())
        file = path.join(DIST, "index.html");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function holdTheme(page, theme) {
  await page.evaluate((t) => {
    const html = document.documentElement;
    const apply = () => {
      if (html.dataset.theme !== t) html.dataset.theme = t;
    };
    apply();
    if (!window.__holdTheme) {
      window.__holdTheme = new MutationObserver(apply);
      window.__holdTheme.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    }
  }, theme);
}

async function open(page, origin, s, theme) {
  // the map opens on the fixtures' region (MapLibre keeps its position in the hash)
  const url = s.url
    ? `${origin}${s.url}&theme=${theme}`
    : `${origin}/${s.query || ""}${s.query ? "&" : "?"}demo=app&as=${s.as}${s.tour ? "&tour=1" : ""}#14/47.0725/15.4380`;
  // a fresh document for every surface: going to the URL the page already shows would keep the last surface's
  // state (an open sheet, a filled field) instead of loading it again
  await page.goto("about:blank");
  // the UI kit's frames are whole app instances, which never settle into network idle together
  await page.goto(url, { waitUntil: s.fullPage ? "load" : "networkidle", timeout: 60000 });
  await holdTheme(page, theme);
  if (s.wait) await page.waitForSelector(s.wait, { timeout: 15000 });
  for (const [kind, sel, value] of s.steps ?? []) {
    if (kind === "click") await page.click(sel, { timeout: 8000 });
    if (kind === "fill") await page.fill(sel, value, { timeout: 8000 });
    await page.waitForTimeout(400);
  }
  if (s.after) await page.waitForSelector(s.after, { timeout: 8000 }).catch(() => {});
  if (s.fullPage) await page.waitForTimeout(6000); // the frames load whole app instances
  await page.waitForTimeout(800); // map tiles, fonts and transitions settle
}

async function main() {
  if (!existsSync(path.join(DIST, "index.html")))
    throw new Error("build the app first: pnpm --filter @aprscaching/web build");
  const exe = findChromium();
  if (!exe) {
    if (process.env.CI) throw new Error("no Chromium: pnpm exec playwright-core install --with-deps chromium");
    console.log("SKIP visual harness: no Chromium (set CHROMIUM_PATH or `pnpm exec playwright-core install chromium`)");
    return;
  }
  const only = arg("only");
  const themes = arg("themes") ?? THEMES;
  const views = arg("views") ?? Object.keys(VIEWS);
  const shots = !process.argv.includes("--no-shots");
  mkdirSync(OUT, { recursive: true });

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const results = [];
  try {
    for (const view of views) {
      for (const theme of themes) {
        const ctx = await browser.newContext({
          viewport: VIEWS[view],
          deviceScaleFactor: 1,
          locale: "en-US",
          timezoneId: "Europe/Vienna",
          serviceWorkers: "block",
          colorScheme: theme === "light" ? "light" : "dark",
          ...VIEWS[view],
        });
        // third-party requests never leave: the map falls back to its offline graticule
        await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
        // the theme: the app's own setting (Phosphor; the rest read as the default), and after load the
        // attribute the token layer keys off, held against the app re-applying its own
        await ctx.addInitScript((t) => {
          try {
            if (!location.search.includes("tour=1")) localStorage.setItem("acs.tour.seen", "1");
            localStorage.setItem("acs.locale", JSON.stringify({ theme: t }));
          } catch {
            /* storage refused */
          }
        }, theme);
        // the fixtures' clock (src/demo/fixtures.ts NOW), so "2 min ago" reads the same in every run
        await ctx.clock.setFixedTime(new Date(Date.UTC(2026, 9, 1, 14, 30)));
        const page = await ctx.newPage();
        for (const s of SURFACES) {
          if (only && !only.includes(s.name)) continue;
          if (s.views && !s.views.includes(view)) continue;
          const id = `${s.name}-${theme}-${view}`;
          const row = { id, surface: s.name, theme, view, error: null, violations: [] };
          try {
            await open(page, origin, s, theme);
            if (shots) await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: !!s.fullPage });
            await page.addScriptTag({ content: AXE });
            const r = await page.evaluate(() =>
              window.axe.run(document, {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
                resultTypes: ["violations"],
              }),
            );
            row.violations = r.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
              count: v.nodes.length,
            }));
          } catch (e) {
            row.error = String(e.message ?? e).split("\n")[0];
          }
          results.push(row);
          const serious = row.violations.filter((v) => v.impact === "serious" || v.impact === "critical").length;
          console.log(
            `${row.error ? "ERR " : "    "}${id.padEnd(34)} ${row.error ?? `${row.violations.length} axe rules (${serious} serious/critical)`}`,
          );
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (process.argv.includes("--keyboard")) await keyboardWalk(exe, origin);
  server.close();

  writeFileSync(path.join(OUT, "axe.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(OUT, "index.html"), indexHtml(results, shots));
  const blocking = results.flatMap((r) =>
    r.violations
      .filter(
        (v) => (v.impact === "serious" || v.impact === "critical") && !v.nodes.every((n) => ALLOW.has(`${v.id}:${n}`)),
      )
      .map((v) => `${r.id}: ${v.id} (${v.impact}) ${v.help}`),
  );
  console.log(
    `\n${results.length} renders, ${results.filter((r) => r.error).length} errors, ${blocking.length} serious/critical axe findings → ${path.relative(process.cwd(), OUT)}/index.html`,
  );
  if (process.argv.includes("--strict") && (blocking.length || results.some((r) => r.error))) process.exit(1);
}

/**
 * The keyboard walk: Tab through a surface from the top and record, for each stop, what has focus, its
 * accessible name and whether a focus indicator is drawn (an outline or a box-shadow that differs from the
 * unfocused element). Written to out/keyboard.json; a stop with no indicator or no name is a finding.
 */
async function keyboardWalk(exe, origin) {
  const walks = [
    { name: "map", as: "user", query: "", view: "desktop", tabs: 30 },
    { name: "nearby", as: "user", query: "?view=nearby", view: "phone", tabs: 25 },
    { name: "settings", as: "user", query: "?view=settings", view: "desktop", tabs: 30 },
    { name: "landing", as: "out", query: "", view: "desktop", tabs: 20 },
  ];
  const browser = await chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const out = [];
  for (const w of walks) {
    const ctx = await browser.newContext({ viewport: VIEWS[w.view], locale: "en-US", serviceWorkers: "block" });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.addInitScript(() => localStorage.setItem("acs.tour.seen", "1"));
    const page = await ctx.newPage();
    await page.goto(`${origin}/${w.query}${w.query ? "&" : "?"}demo=app&as=${w.as}#14/47.0725/15.4380`, {
      waitUntil: "networkidle",
    });
    await page.waitForTimeout(800);
    const stops = [];
    for (let i = 0; i < w.tabs; i++) {
      await page.keyboard.press("Tab");
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return { tag: "body" };
          // the ring may be drawn by the element or by a wrapper through :focus-within (a search field)
          const drawn = (n) => {
            const cs = getComputedStyle(n);
            return (
              (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) ||
              (cs.boxShadow && cs.boxShadow !== "none")
            );
          };
          const ring = [el, el.parentElement, el.parentElement?.parentElement].some((n) => n && drawn(n));
          const r = el.getBoundingClientRect();
          const name =
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.textContent?.trim().slice(0, 40) ||
            el.getAttribute("placeholder") ||
            "";
          return {
            tag: el.tagName.toLowerCase(),
            cls: String(el.className).slice(0, 40),
            name,
            ring,
            w: Math.round(r.width),
            h: Math.round(r.height),
            visible: r.width > 0 && r.top < innerHeight && r.bottom > 0,
          };
        }),
      );
    }
    out.push({ walk: `${w.name}-${w.view}`, stops });
    const bad = stops.filter((s) => s.tag !== "body" && (!s.ring || !s.name || !s.visible));
    console.log(
      `keyboard ${w.name}-${w.view}: ${stops.length} stops, ${bad.length} without a visible ring, a name or on screen`,
    );
    await ctx.close();
  }
  await browser.close();
  writeFileSync(path.join(OUT, "keyboard.json"), JSON.stringify(out, null, 2));
}

function indexHtml(results, shots) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = results
    .map(
      (r) =>
        `<section><h2>${esc(r.id)}</h2>${r.error ? `<p class=err>${esc(r.error)}</p>` : ""}${shots && !r.error ? `<img loading=lazy src="${esc(r.id)}.png" alt="${esc(r.surface)} in the ${esc(r.theme)} theme at the ${esc(r.view)} size">` : ""}<ul>${r.violations.map((v) => `<li><b>${esc(v.impact)}</b> ${esc(v.id)} — ${esc(v.help)} (${v.count}): <code>${esc(v.nodes.join(" | "))}</code></li>`).join("")}</ul></section>`,
    )
    .join("\n");
  return `<!doctype html><meta charset=utf-8><title>aprscaching visual + axe harness</title><style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}img{max-width:100%;max-height:70vh;border:1px solid #444}section{margin:0 0 32px}.err{color:#f88}code{color:#9cf}</style><h1>Visual + axe harness</h1>${rows}`;
}

await main();
