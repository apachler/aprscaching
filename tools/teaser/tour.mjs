// Full UI tour: drive the live app through a sane step-by-step journey at desktop / tablet / mobile,
// screenshotting every page + dialog. Frames are numbered in journey order for the teaser video.
// Desktop (≥1024) navigates via the NavRail (.rail); tablet/mobile via the top-bar nav / bottom TabBar.
//
// Self-maintaining: the interaction-gated DIALOGS (landing, sign-in, filter, cache detail, hide) are
// scripted, but the DESTINATIONS are discovered at runtime — desktop enumerates the NavRail and
// tablet/mobile enumerate the Profile → Advanced tools — so a newly added top-level page is captured
// without editing this file. Only a brand-new interaction dialog needs a new step(...).
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
// Open the Workbench panel (desktop rail, else Profile → Advanced → Workbench).
async function openWorkbench(page) {
  await closeAll(page);
  if (!(await clickAny(page, [".rail button[title='Bench']"]))) {
    await clickAny(page, ["button[title^='Profile']", ".tabbar button:has-text('You')"]);
    await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
    await clickAny(page, [".group-toggle:has-text('Advanced')"]);
    await clickAny(page, ["button:has-text('Workbench')"]);
  }
  await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);
}
// Expand a named workbench group (e.g. "Packet terminal", "Tools") + scroll it into view for the shot.
async function expandGroup(page, title) {
  const toggle = page.locator(`.group-toggle:has-text('${title}')`).first();
  if (!(await toggle.isVisible().catch(() => false))) throw new Error(`group '${title}' not found`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click().catch(() => {});
  await page.waitForTimeout(500);
  await toggle.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
}

// Friendlier captions for the terse rail/tab titles; unknown titles fall back to themselves.
const LABELS = {
  Map: "Live cache map", Nearby: "Nearby caches", Activity: "Activity feed", Ranks: "Leaderboard",
  Bench: "Workbench — APRS toolset", BBS: "BBS — store & forward mail", You: "Profile", Setup: "Settings",
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "view";

// Enumerate the tools revealed under Profile → Advanced — the small-viewport home for Workbench/BBS/
// Settings and any tool added later — so they're captured without being listed here. Returns
// { full: button text incl. glyph, name: slug, label: caption } for each emoji/glyph-prefixed tool.
async function advancedTools(page) {
  await closeAll(page);
  if (!(await clickAny(page, ["button[title^='Profile']", ".tabbar button:has-text('You')"]))) return [];
  await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
  await clickAny(page, [".group-toggle:has-text('Advanced')"]);
  await page.waitForTimeout(300);
  // tool buttons read like "📡 Workbench": a leading glyph THEN a word. Require letters so bare-glyph
  // controls (e.g. the panel's ✕ close button) are not mistaken for destinations.
  const labels = await page.$$eval(".panel button", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t && /^[^\w\s]/.test(t) && /[A-Za-z]{2,}/.test(t) && t.length <= 28)
  ).catch(() => []);
  const seen = new Set();
  return labels.filter((t) => !seen.has(t) && seen.add(t)).map((t) => ({
    full: t, name: slug(t), label: t.replace(/^[^\w]+\s*/, "") || t,
  }));
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

  // --- destinations: auto-discovered, so new pages are captured without editing this script ---
  // Desktop exposes the canonical, COMPLETE destination set in the NavRail, so we enumerate it at
  // runtime — a new rail page is captured automatically. Tablet/mobile deliberately keep a minimal
  // primary nav (Nearby/Activity/Profile) and funnel the rest behind Profile → Advanced, so there
  // we capture the primary trio, the leaderboard (via the Activity panel link), and every tool
  // discovered under the Advanced disclosure.
  // NB: the rail exists in the DOM at every viewport (CSS display:none below 1024px), so gate on
  // VISIBILITY — $$eval would otherwise return the hidden rail titles on tablet/mobile and wrongly
  // take the desktop branch.
  const railVisible = await page.locator(".rail").first().isVisible().catch(() => false);
  const rail = railVisible
    ? await page.$$eval(".rail button[title]", (els) => els.map((e) => e.getAttribute("title")).filter(Boolean)).catch(() => [])
    : [];

  if (rail.length) {
    for (const title of rail.filter((t) => !/^map$/i.test(t))) {
      await step(title, async () => {
        await closeAll(page);
        if (!(await clickAny(page, [`.rail button[title='${title}']`]))) throw new Error("rail item not found");
        await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(450);
        await shot(page, v.id, slug(title), LABELS[title] || title);
      });
    }
  } else {
    for (const t of ["Nearby", "Activity"]) {
      await step(t, async () => {
        await closeAll(page);
        await clickAny(page, [`.nav-desktop button:has-text('${t}')`, `.tabbar button:has-text('${t}')`]);
        await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(400);
        await shot(page, v.id, slug(t), LABELS[t]);
      });
    }
    await step("leaderboard", async () => {
      await closeAll(page);
      await clickAny(page, [".nav-desktop button:has-text('Activity')", ".tabbar button:has-text('Activity')"]);
      await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
      await clickAny(page, [".panel button:has-text('full leaderboard')"]);
      await page.waitForSelector(".panel .board, .panel .logs, .panel table", { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(450);
      await shot(page, v.id, "leaderboard", "Leaderboard");
    });
    await step("profile", async () => {
      await closeAll(page);
      await clickAny(page, ["button[title^='Profile']", ".tabbar button:has-text('You')"]);
      await page.waitForSelector(".panel .group", { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(400);
      await shot(page, v.id, "profile", "Profile");
    });
    for (const tool of await advancedTools(page)) {
      await step(tool.name, async () => {
        await closeAll(page);
        if (!(await openProfileAdvanced(page, tool.full))) throw new Error("advanced tool not found");
        await page.waitForSelector(".panel .group, .panel h2, .panel", { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(450);
        await shot(page, v.id, tool.name, tool.label);
      });
    }
  }

  // --- Workbench deep-dive: showcase the packet stack (Stage 1) + the Tools plugins (Stage 2) ---
  await step("packet", async () => {
    await openWorkbench(page);
    await expandGroup(page, "Packet terminal");
    await clickAny(page, [".node-panel button:has-text('NODES')"]); // reveal the NET/ROM node view
    await page.waitForTimeout(400);
    await shot(page, v.id, "packet", "Packet terminal — Graphic Packet reborn");
  });
  await step("tools", async () => {
    await openWorkbench(page);
    await expandGroup(page, "Tools");
    await shot(page, v.id, "tools", "Tools — sandboxed plugins");
  });

  // Site map page — reached via the ?view= deep-link (dogfooding the sitemap tooling). Captured on
  // every viewport regardless of where it sits in nav.
  await step("sitemap", async () => {
    await page.goto(`${BASE}/?view=sitemap#11.5/47.078/15.43`, { waitUntil: "load" });
    await ready(page);
    await page.waitForSelector(".panel", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, v.id, "sitemap", "Site map");
  });

  await ctx.close();
  await browser.close();
}

fs.writeFileSync(OUT + `manifest-${only ?? "all"}.json`, JSON.stringify(manifest, null, 2));
console.log(`\ntour complete (${only ?? "all"}): ${seq} frames -> ${OUT}`);
