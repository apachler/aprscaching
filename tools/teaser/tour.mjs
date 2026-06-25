// Full UI tour: drive the live app through a sane step-by-step journey at desktop / tablet / mobile,
// screenshotting every page + dialog. Frames are numbered in journey order for the teaser video.
// Desktop (≥1024) navigates via the NavRail (.rail); tablet/mobile via the top-bar nav / bottom TabBar.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = (process.env.OUT ?? new URL("./tour", import.meta.url).pathname).replace(/\/?$/, "/");
const EXE = process.env.PW_CHROMIUM || undefined;
fs.mkdirSync(OUT, { recursive: true });

let browser;
async function launchBrowser() {
  return chromium.launch({
    executablePath: EXE,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}

const ALL = [
  { id: "desktop", w: 1440, h: 900, dsf: 1 },
  { id: "tablet", w: 834, h: 1112, dsf: 1 },
  { id: "mobile", w: 390, h: 844, dsf: 2 },
];
// Run ONE viewport per process (VIEW env): the software-rendered map is memory-heavy, so isolating each
// viewport in its own node process lets the OS fully reap chrome between them (avoids the OOM killer).
const only = process.env.VIEW;
const VIEWS = only ? ALL.filter((v) => v.id === only) : ALL;
const viewIndex = (id) => ALL.findIndex((v) => v.id === id) + 1; // 1..3 → frame-order prefix

let seq = 0;
const manifest = [];
async function shot(page, vid, name, label) {
  seq++;
  const file = `${viewIndex(vid)}-${String(seq).padStart(2, "0")}-${vid}-${name}.png`;
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + file });
  manifest.push({ file, viewport: vid, name, label });
  console.log("  ✓", file, "—", label);
}
async function ctxFor(v, app = true) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.dsf });
  await ctx.addInitScript((isApp) => {
    try {
      if (isApp) { localStorage.setItem("acs.call", "OE8APR"); sessionStorage.setItem("acs.explore", "1"); }
      else { localStorage.removeItem("acs.call"); sessionStorage.removeItem("acs.explore"); }
    } catch { /* ignore */ }
  }, app);
  return ctx;
}
async function ready(page) {
  // The map canvas is the reliable readiness signal (pins may sit outside the viewport, so don't
  // gate on them). Wait for the splash to actually detach, then for the MapLibre canvas to paint.
  await page.waitForSelector(".splash", { state: "detached", timeout: 12000 }).catch(() => {});
  await page.waitForSelector(".maplibregl-canvas", { state: "visible", timeout: 12000 }).catch(() => {});
  await page.waitForSelector(".cache-pin, .beacon-pin", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(900);
}
async function gotoMap(page) {
  await page.goto(`${BASE}/#11.5/47.078/15.43`, { waitUntil: "load" });
  await ready(page);
}
// lightweight reset between steps (no reload): exit hide mode + close any open panel. The desktop rail
// and the mobile tab bar stay visible regardless of mode, so a reload isn't needed.
async function closeAll(page) {
  await clickAny(page, ["header.topbar button:has-text('Cancel')"]);
  for (let i = 0; i < 4; i++) { if (!(await clickAny(page, [".panel button[aria-label='Close']"]))) break; await page.waitForTimeout(120); }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
}
async function clickAny(page, sels) {
  for (const s of sels) {
    const el = page.locator(s).first();
    if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return true; }
  }
  return false;
}
async function clickCache(page, match) {
  await page.evaluate((m) => {
    const els = [...document.querySelectorAll("button.cache-pin, img.beacon-pin")];
    (els.find((e) => (e.title || "").includes(m)) || els[0])?.click();
  }, match);
  await page.waitForSelector(".panel", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
}
// open a destination: desktop via the rail (title=), else the top-bar/tab-bar, else Profile→Advanced.
async function openDest(page, railTitle, fallbacks = []) {
  if (await clickAny(page, [`.rail button[title='${railTitle}']`])) return true;
  return clickAny(page, fallbacks);
}
async function openProfileAdvanced(page, btnText) {
  if (!(await clickAny(page, ["button[title^='Profile']", ".tabbar button:has-text('You')"]))) return false;
  await page.waitForSelector(".panel .group", { timeout: 6000 }).catch(() => {});
  await clickAny(page, [".group-toggle:has-text('Advanced')"]);
  await page.waitForTimeout(300);
  return clickAny(page, [`button:has-text('${btnText}')`]);
}
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log("   ! skip", name, "-", String(e.message).split("\n")[0]); }
}

for (const v of VIEWS) {
  console.log("==>", v.id);
  browser = await launchBrowser();

  // signed-out: landing + sign-in dialog
  await step("landing", async () => {
    const ctx = await ctxFor(v, false); const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".landing", { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, v.id, "landing", "Landing — signed out");
    await step("signin", async () => {
      await page.click(".landing .primary");
      await page.waitForTimeout(700);
      await shot(page, v.id, "signin", "Sign in / register");
    });
    await ctx.close();
  });

  // signed-in demo journey (one context; reset to the map before each destination)
  let ctx, page;
  try {
    ctx = await ctxFor(v, true); page = await ctx.newPage();
    await gotoMap(page);
  } catch (e) {
    console.log("   !! app setup failed for", v.id, "-", String(e.message).split("\n")[0]);
    try { await browser.close(); } catch {}
    continue;
  }
  await step("map", async () => shot(page, v.id, "map", "Live cache map"));

  await step("filter", async () => {
    await closeAll(page);
    await clickAny(page, ["button[title='Filter by type']"]);
    await page.waitForSelector(".panel", { timeout: 6000 });
    await shot(page, v.id, "filter", "Search & filter");
  });

  await step("detail", async () => {
    await closeAll(page);
    await clickCache(page, "Schlossberg");
    await shot(page, v.id, "detail", "Cache detail + logbook");
  });

  await step("hide", async () => {
    await closeAll(page);
    await clickAny(page, ["button.primary:has-text('Hide a cache')", ".tabbar .fab"]);
    await page.waitForSelector(".panel", { timeout: 6000 });
    await page.locator(".maplibregl-canvas").click({ position: { x: Math.round(v.w * 0.5), y: Math.round(v.h * 0.42) } }).catch(() => {});
    await page.waitForTimeout(400);
    await page.fill('.panel label:has-text("Title") input', "Castle Casemates").catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, v.id, "hide", "Hide a cache");
  });

  await step("nearby", async () => {
    await closeAll(page);
    await openDest(page, "Nearby", [".nav-desktop button:has-text('Nearby')", ".tabbar button:has-text('Nearby')"]);
    await page.waitForSelector(".panel", { timeout: 6000 });
    await shot(page, v.id, "nearby", "Nearby caches");
  });

  await step("activity", async () => {
    await closeAll(page);
    await openDest(page, "Activity", [".nav-desktop button:has-text('Activity')", ".tabbar button:has-text('Activity')"]);
    await page.waitForSelector(".panel", { timeout: 6000 });
    await page.waitForTimeout(400);
    await shot(page, v.id, "activity", "Activity feed");
  });

  await step("leaderboard", async () => {
    await closeAll(page);
    if (!(await openDest(page, "Ranks", []))) {
      // tablet/mobile: open Activity, then the "full leaderboard →" link
      await openDest(page, "Activity", [".nav-desktop button:has-text('Activity')", ".tabbar button:has-text('Activity')"]);
      await page.waitForSelector(".panel", { timeout: 6000 });
      await clickAny(page, [".panel button:has-text('full leaderboard')"]);
    }
    await page.waitForSelector(".panel .board, .panel .logs, .panel table", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, v.id, "leaderboard", "Leaderboard");
  });

  await step("profile", async () => {
    await closeAll(page);
    await openDest(page, "You", ["button[title^='Profile']", ".tabbar button:has-text('You')"]);
    await page.waitForSelector(".panel .group", { timeout: 6000 });
    await page.waitForTimeout(400);
    await shot(page, v.id, "profile", "Profile");
  });

  await step("workbench", async () => {
    await closeAll(page);
    if (!(await openDest(page, "Bench", [])) ) await openProfileAdvanced(page, "📡 Workbench");
    await page.waitForSelector(".panel .group, .panel h2", { timeout: 6000 });
    await page.waitForTimeout(500);
    await shot(page, v.id, "workbench", "Workbench — APRS toolset");
  });

  await step("bbs", async () => {
    await closeAll(page);
    if (!(await openDest(page, "BBS", [])) ) await openProfileAdvanced(page, "✉ BBS");
    await page.waitForSelector(".panel", { timeout: 6000 });
    await page.waitForTimeout(500);
    await shot(page, v.id, "bbs", "BBS — store & forward mail");
  });

  await step("settings", async () => {
    await closeAll(page);
    if (!(await openDest(page, "Setup", [])) ) await openProfileAdvanced(page, "⚙ Settings");
    await page.waitForSelector(".panel", { timeout: 6000 });
    await page.waitForTimeout(500);
    await shot(page, v.id, "settings", "Settings");
  });

  await ctx.close();
  await browser.close();
}

fs.writeFileSync(OUT + `manifest-${only ?? "all"}.json`, JSON.stringify(manifest, null, 2));
console.log(`\ntour complete (${only ?? "all"}): ${seq} frames -> ${OUT}`);
