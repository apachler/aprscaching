// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * offline-shell.mjs — a headless Chromium end-to-end test of the offline app shell. The service worker's
 * logic is unit-tested against stand-in globals (apps/web/test/sw.test.ts); this proves the real thing in a
 * real engine: the built app, served once with a connection, opens again with none.
 *
 *   1. Serve apps/web/dist (build it first: pnpm --filter @aprscaching/web build) with a stand-in
 *      gateway that answers the session check with a signed-in call.
 *   2. Open the app: the service worker installs, stores the shell and takes control.
 *   3. Cut the connection and reload: the app starts from the stored shell, signed in as the remembered
 *      call, with the map (MapLibre comes from the shell too).
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

/** The built app, plus a stand-in gateway: a signed-in session, and nothing else (every API call fails). */
function serve() {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    };
    if (url.pathname === "/auth/session")
      return send(200, TYPES[".json"], JSON.stringify({ callsign: CALL, verified: true }));
    if (url.pathname === "/.well-known/aprscaching")
      return send(200, TYPES[".json"], JSON.stringify({ instance: "e2e.test" }));
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

  const server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: exe });
  const failures = [];
  const check = (name, ok) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) failures.push(name);
  };
  try {
    const context = await browser.newContext();
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
    const pushHandlers = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg?.pushManager;
    });
    check("the registration still offers Web Push", pushHandlers);
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) {
    console.error(`offline-shell: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("OFFLINE SHELL E2E PASSED");
}

await main();
