// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * offline-shell.mjs — a headless Chromium end-to-end test of the offline app shell. The service worker's
 * logic is unit-tested against stand-in globals (apps/web/test/sw.test.ts); this proves the real thing in a
 * real engine: the built app, served once with a connection, opens again with none.
 *
 *   1. Serve apps/web/dist (build it first: pnpm --filter @aprscaching/web build) with a stand-in
 *      gateway that answers the session check with a signed-in call.
 *   2. Open the app: the service worker installs, stores the shell and takes control.
 *   3. Make an offline pack of the locator square at the map centre in the Offline panel (the stand-in
 *      gateway answers with one cache in the middle of the square), so it lands in IndexedDB.
 *      The instance offers an offline map (a one-tile PMTiles archive, read by byte range), which the pack
 *      takes along.
 *   4. Cut the connection and reload: the app starts from the stored shell, signed in as the remembered
 *      call, with the map (MapLibre comes from the shell too) drawing the pack's tiles and showing its caches.
 *   5. A visitor, signed out, makes a pack too. Then the instance goes away while the device still reports a
 *      connection, and the basemap's style answers from the cache while its tiles' description never does: a
 *      new visit opens the landing, Explore reaches the map with the pack's caches, and search finds them.
 *
 * If no Chromium is found it prints SKIP and exits 0, like audio-mic.mjs, and fails in CI (`CI` set), where
 * the e2e-offline job installs one.
 * Browser resolution: $CHROMIUM_PATH, then /opt/pw-browsers/chromium-*, then playwright-core's registry.
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { locatorBounds } from "../../packages/shared/src/offlinepack.ts";
import { buildArchive } from "../../apps/web/test/fixtures/pmtiles.ts";

/** The instance's offline map: one world tile at zoom 0, enough for a pack to hold and draw. */
const ARCHIVE = buildArchive([{ z: 0, x: 0, y: 0, bytes: [0x1a, 0x00] }]);
const MAP_ATTRIBUTION = "© E2E test map";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, "apps/web/dist");
const CALL = "OE8TST";

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    for (const d of readdirSync("/opt/pw-browsers")) {
      if (!d.startsWith("chromium-")) continue;
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {
    /* no such dir */
  }
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
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

/** One offline pack for the requested locator square: a single cache in its middle. */
function pack(url) {
  const [w, s, e, n] = locatorBounds(url.searchParams.get("grid") ?? "JN77");
  const cache = {
    globalId: "e2e.test:cache:1",
    id: 1,
    code: "AC-E2E",
    ownerCall: "OE8OWN",
    title: "Offline test cache",
    type: "traditional",
    status: "active",
    difficulty: 1,
    terrain: 1,
    lat: (s + n) / 2,
    lon: (w + e) / 2,
    origin: "e2e.test",
    mirrored: false,
    originTrust: "native",
    source: "native",
    sourceName: null,
    sourceUrl: null,
    stationCall: null,
    minTrust: null,
    fedScope: "public",
    driveIn: false,
    country: null,
    tags: [],
    externalId: null,
    hint: "under the stone",
    description: "for the offline test",
    createdAt: 1,
    updatedAt: 1,
    stages: [],
    logs: [],
    images: [],
  };
  return { instance: "e2e.test", generation: "e2e1", builtAt: 1, caches: [cache] };
}

/**
 * The built app, plus a stand-in gateway: a session (signed in, or none for a visitor), an empty map, one offline
 * pack, nothing else.
 */
function serve({ signedIn = true } = {}) {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    };
    if (url.pathname === "/auth/session")
      return send(
        200,
        TYPES[".json"],
        JSON.stringify(signedIn ? { callsign: CALL, verified: true } : { callsign: null }),
      );
    if (url.pathname === "/.well-known/aprscaching")
      return send(200, TYPES[".json"], JSON.stringify({ instance: "e2e.test" }));
    if (url.pathname === "/api/caches") return send(200, TYPES[".json"], JSON.stringify({ caches: [] }));
    if (url.pathname === "/api/offline/pack") return send(200, TYPES[".json"], JSON.stringify(pack(url)));
    if (url.pathname === "/api/offline/tiles")
      return send(
        200,
        TYPES[".json"],
        JSON.stringify({ url: "/tiles/offline.pmtiles", attribution: MAP_ATTRIBUTION, maxZoom: 14 }),
      );
    if (url.pathname === "/tiles/offline.pmtiles") {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!m) return send(416, "text/plain", "ask for a range");
      const start = Number(m[1]),
        end = Math.min(Number(m[2]), ARCHIVE.length - 1);
      res.writeHead(206, {
        "content-type": "application/vnd.pmtiles",
        "content-range": `bytes ${start}-${end}/${ARCHIVE.length}`,
      });
      return res.end(Buffer.from(ARCHIVE.subarray(start, end + 1)));
    }
    if (/^\/(api|auth|federation|ws|health)\b/.test(url.pathname))
      return send(404, TYPES[".json"], JSON.stringify({ error: "not in this test" }));
    let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory())
      file = path.join(DIST, "index.html");
    send(200, TYPES[path.extname(file)] ?? "application/octet-stream", readFileSync(file));
  });
}

async function main() {
  const exe = findChromium();
  if (!exe) {
    // in CI a missing browser is a broken job, never a pass
    if (process.env.CI)
      throw new Error("no Chromium in CI: install it with pnpm exec playwright-core install --with-deps chromium");
    console.log(
      "SKIP offline-shell: no Chromium found (set CHROMIUM_PATH or `pnpm exec playwright-core install chromium`)",
    );
    return;
  }
  if (
    !existsSync(path.join(DIST, "sw.js")) ||
    readFileSync(path.join(DIST, "sw.js"), "utf8").includes("const PRECACHE = [];")
  )
    throw new Error("apps/web/dist has no built service worker: run pnpm --filter @aprscaching/web build first");

  const browser = await chromium.launch({ executablePath: exe });
  const failures = [];
  const check = (name, ok) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) failures.push(name);
  };
  try {
    await signedInOffline(browser, check);
    await visitorOffline(browser, check);
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`offline-shell: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("OFFLINE SHELL E2E PASSED");
}

/** Start a stand-in gateway; resolves to its base URL and a stop that also drops open connections. */
async function start(opts) {
  const server = serve(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

/** Make a pack of the subsquare at the map centre in the Offline panel; resolves once it is saved. */
async function makePack(page) {
  await page.click('.rail >> role=button[name="Offline"s]');
  await page.click('.newpack .seg button:has-text("Subsquare")');
  await page.click('button:has-text("Check size")');
  await page.waitForSelector(".pack-estimate", { timeout: 15_000 });
  await page.click('.pack-estimate button:has-text("Download")');
  return page
    .waitForSelector('.pack:has-text("1 caches")', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

const seen = (page, selector, timeout = 15_000, state = "visible") =>
  page
    .waitForSelector(selector, { timeout, state })
    .then(() => true)
    .catch(() => false);

/**
 * A visitor, signed out, makes a pack, and later opens the app where the instance cannot be reached while the
 * device still reports a connection: the landing, then Explore, reaches the map with the pack's caches, and
 * search finds them. The basemap's style comes from the browser's cache but its tiles' description does not
 * load, so the map has to fall back to the self-contained style on its own.
 */
async function visitorOffline(browser, check) {
  const gw = await start({ signedIn: false });
  const context = await browser.newContext();
  try {
    await context.route(/^https:\/\/tiles\.openfreemap\.org\//, (r) => r.abort());
    const page = await context.newPage();
    await page.goto(gw.base);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    await page.click('button:has-text("Explore the live map")');
    check("visitor online: Explore opens the map", await seen(page, ".maplibregl-map", 30_000));
    await page.click('.tour-card button:has-text("Skip")', { timeout: 5_000 }).catch(() => {});
    check("visitor online: a pack of the subsquare at the map centre is saved", await makePack(page));

    // the instance is gone, the device still says it is online, and the basemap's style is read from the cache
    await gw.stop();
    await context.unroute(/^https:\/\/tiles\.openfreemap\.org\//);
    await context.route(/^https:\/\/tiles\.openfreemap\.org\//, (r) =>
      r.request().url().includes("/styles/")
        ? r.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              version: 8,
              sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
              layers: [{ id: "background", type: "background", paint: { "background-color": "#ddd" } }],
            }),
          })
        : // the tiles' description never answers, as on a link that is up but carries nothing
          new Promise(() => {}),
    );
    // a new visit: the app's own address, a fresh browser session
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(gw.base);
    check("visitor offline: the landing opens", await seen(page, 'button:has-text("Explore the live map")', 30_000));
    await page.click('button:has-text("Explore the live map")');
    check(
      "visitor offline: Explore reaches the map with the pack's caches",
      await seen(page, '.offline-banner:has-text("caches from pack")', 30_000),
    );
    check("visitor offline: the splash is gone", await seen(page, ".splash", 15_000, "detached"));
    await page.fill(".topsearch input", "AC-E2E");
    check("visitor offline: search finds the pack's cache", await seen(page, '.search-opt:has-text("AC-E2E")'));
  } finally {
    await context.close();
    await gw.stop().catch(() => {});
  }
}

/** A signed-in player makes a pack, then opens the app with no connection at all. */
async function signedInOffline(browser, check) {
  const { base, stop } = await start({ signedIn: true });
  try {
    const context = await browser.newContext();
    // the online basemap's host is unreachable throughout, so a cached copy of its style can never make the
    // offline map work by accident: the map has to fall back to the self-contained style
    await context.route(/^https:\/\/tiles\.openfreemap\.org\//, (r) => r.abort());
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 60_000 });
    check("the service worker controls the app after the first visit", true);
    await page.waitForSelector(`.idchip:has-text("${CALL}")`, { timeout: 30_000 });
    check("online: signed in", true);
    const stored = await page.evaluate(async () => {
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith("acs-shell-"));
      return shell ? (await (await caches.open(shell)).keys()).length : 0;
    });
    check(`the shell is stored (${stored} files)`, stored > 10);

    check("a pack of the subsquare at the map centre is saved (IndexedDB)", await makePack(page));

    await context.setOffline(true);
    await page.reload();
    const signedIn = await page
      .waitForSelector(`.idchip:has-text("${CALL}")`, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check("offline: the app opens, signed in as the remembered call", signedIn);
    const map = await page
      .waitForSelector(".maplibregl-map", { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check("offline: the map loads from the shell", map);
    const offlineMap = await page
      .waitForSelector(`.maplibregl-ctrl-attrib:has-text("${MAP_ATTRIBUTION}")`, { state: "attached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check("offline: the map draws the pack's own tiles (its attribution shows)", offlineMap);
    const banner = await page
      .waitForSelector('.offline-banner:has-text("caches from pack")', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check("offline: the map shows the pack's caches and says so", banner);
    const pushHandlers = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg?.pushManager;
    });
    check("the registration still offers Web Push", pushHandlers);
    await context.close();
  } finally {
    await stop();
  }
}

await main();
