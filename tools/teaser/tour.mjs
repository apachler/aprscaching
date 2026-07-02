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
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:8799";
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
let curView = process.env.VIEW ?? "all"; // set per viewport in the loop; tags problem records
const manifest = [];
const problems = []; // { viewport, step, reason } for any step that failed — surfaced at end of run
async function shot(page, vid, name, label) {
  seq++;
  const file = `${viewIndex(vid)}-${String(seq).padStart(2, "0")}-${vid}-${name}.png`;
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + file });
  manifest.push({ file, viewport: vid, name, label });
  console.log("  ✓", file, "—", label);
}
const THEME = process.env.THEME || ""; // "cogmind" → capture the whole tour in the green-phosphor flip
async function ctxFor(v, app = true) {
  const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.dsf });
  await ctx.addInitScript(([isApp, theme]) => {
    try {
      if (isApp) { localStorage.setItem("acs.call", "OE8APR"); sessionStorage.setItem("acs.explore", "1"); }
      else { localStorage.removeItem("acs.call"); sessionStorage.removeItem("acs.explore"); }
      if (theme) localStorage.setItem("acs.locale", JSON.stringify({ theme }));
    } catch { /* ignore */ }
  }, [app, THEME]);
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
// Sign in for REAL via the email dev-link (no email provider in dev → the gateway returns the link
// directly), so the tour reaches the sign-in-gated surfaces (Settings groups, save-view, GDPR, …).
// The app must be loaded first so the credentialed fetch runs from its origin. Idempotent across
// viewports: the first registers OE8APR, the rest log in. Throws on failure so the caller can fall
// back to explore mode.
async function signIn(page) {
  await page.goto(`${BASE}/`, { waitUntil: "load" }).catch(() => {});
  const r = await page.evaluate(async (api) => {
    const res = await fetch(api + "/auth/email/start", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "oe8apr@teaser.local", callsign: "OE8APR" }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, API_BASE);
  const link = r.body && r.body.devLink;
  if (!link) throw new Error(`no devLink (status ${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
  await page.goto(link, { waitUntil: "load" }).catch(() => {}); // consumes the token, sets the session cookie
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
  try { await fn(); }
  catch (e) {
    const reason = String(e.message).split("\n")[0];
    problems.push({ viewport: curView, step: name, reason });
    console.log("   ✗ SKIP", `[${curView}]`, name, "-", reason);
  }
}
// Open the Workbench panel deterministically via the ?view=workbench deep-link (the same one-shot
// mechanism the Site map / sitemap.xml consumers use) rather than navigating the stateful rail. This
// works on EVERY viewport (desktop/tablet/mobile — navigate() just calls setShowWB) and is immune to
// accumulated journey state (a stuck "Hide a cache" mode won't swallow the open). Gate readiness on the
// "Packet terminal" group being attached, retrying once.
let navSeq = 0; // bump per goto so the URL is never byte-identical (same-URL goto = no reload → stale surface)
async function openWorkbench(page) {
  const marker = () => page.locator(".wb-apps").first();  // the launcher grid (workbench is a pure launcher now)
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE}/?view=workbench&n=${++navSeq}#11.5/47.078/15.43`, { waitUntil: "load" });
    await ready(page);
    try { await marker().waitFor({ state: "attached", timeout: 6000 }); await page.waitForTimeout(300); return; }
    catch { /* retry the open once */ }
  }
  throw new Error("workbench did not open");
}
// Open a surface via its ?view= deep-link (nonce so same-URL gotos actually reload) and wait for it.
async function openView(page, view, waitSel) {
  await page.goto(`${BASE}/?view=${view}&n=${++navSeq}#11.5/47.078/15.43`, { waitUntil: "load" });
  await ready(page);
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}
// Expand a named workbench group (e.g. "Packet terminal", "Tools") + scroll it into view for the shot.
async function expandGroup(page, title) {
  const toggle = page.locator(".group-toggle", { hasText: title }).first();
  await toggle.waitFor({ state: "visible", timeout: 6000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click().catch(() => {});
  await page.waitForTimeout(500);
  await toggle.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
}
// Open a `?demo=` harness route (the hardware-free simulator: real components + in-process sims). The
// hardware/gated surfaces (packet terminal, BBS, CAT rig, remote box) can't populate against a headless
// browser with no TNC/radio, so the teaser shows them here in demo mode — populated and working. These
// routes render their own app shell (no MapLibre canvas), so wait on the surface selector, not ready().
async function gotoDemo(page, variant, waitSel) {
  await page.goto(`${BASE}/?demo=${variant}`, { waitUntil: "load" });
  await page.waitForSelector(waitSel, { timeout: 12000 });
  await page.waitForTimeout(800);
}
// Launch a workbench app from the drawer's launcher (every app opens its own surface now) and wait for
// it. Used for the apps that work against the seeded gateway (tools, node, decoder) — the hardware ones
// (terminal, rig, remote) + BBS are shown via the ?demo= sims instead.
async function launchWbApp(page, label, waitSel) {
  await openWorkbench(page);
  await page.locator(".wb-app-launch", { hasText: label }).first().click().catch(() => {});
  await page.waitForSelector(waitSel, { timeout: 8000 });
  await page.waitForTimeout(400);
}

// Friendlier captions for the terse rail/tab titles; unknown titles fall back to themselves.
const LABELS = {
  Map: "Live cache map", Nearby: "Nearby caches", Activity: "Activity feed", Ranks: "Leaderboard",
  Bench: "Workbench — APRS toolset", BBS: "BBS — store & forward mail", You: "Profile", Setup: "Settings",
  Admin: "Instance admin — operator only",
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

// Expand EVERY collapsible group (.group-toggle) in the currently-open panel/drawer and screenshot
// each one — exhaustive + self-maintaining, so a new disclosure section is captured without editing
// this script. Used for Settings and the Instance-admin drawer; any multi-group drawer can reuse it.
async function captureGroups(page, vid, prefix, panelLabel) {
  // Start from a clean slate: collapse EVERY group so exactly ONE is ever open per shot (some groups —
  // e.g. Display — default open). Without this the first non-default group would be shot with the
  // default-open one still expanded. Iterate to a fixed point since collapsing can't re-open others.
  const allToggles = page.locator(".panel .group-toggle");
  const nAll = await allToggles.count().catch(() => 0);
  for (let i = 0; i < nAll; i++) {
    const g = allToggles.nth(i);
    if ((await g.getAttribute("aria-expanded").catch(() => null)) === "true") { await g.click().catch(() => {}); await page.waitForTimeout(120); }
  }
  await page.waitForTimeout(200);
  const titles = await page.$$eval(".panel .group-toggle", (els) =>
    els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  for (const t of titles) {
    const short = (t.split(/\s{2,}|·/)[0].replace(/^[▸▾▿►▼▶\s]+/, "").trim().slice(0, 40)) || t;
    await step(`${prefix}-${slug(short)}`, async () => {
      const toggle = page.locator(".panel .group-toggle", { hasText: short }).first();
      await toggle.waitFor({ state: "visible", timeout: 5000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click().catch(() => {});
      await page.waitForTimeout(350);
      await toggle.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);
      await shot(page, vid, `${prefix}-${slug(short)}`, `${panelLabel} — ${short}`);
      if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click().catch(() => {}); // collapse so the next shot is clean
    });
  }
  return titles.length;
}

for (const v of VIEWS) {
  curView = v.id;
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
  let ctx, page, signedIn = false;
  try {
    ctx = await ctxFor(v, true); page = await ctx.newPage();
    try { await signIn(page); signedIn = true; }
    catch (e) { console.log("   (real sign-in failed — explore mode, gated surfaces skip):", String(e.message).split("\n")[0]); }
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

  await step("qr", async () => {
    await closeAll(page);
    await clickCache(page, "Schlossberg");
    await clickAny(page, [".panel button:has-text('QR')"]);
    await page.waitForSelector(".panel canvas, .panel svg, .panel img[src^='data:']", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, v.id, "qr", "Per-cache QR — scan to find");
  });

  await step("logfind", async () => {
    await closeAll(page);
    await clickCache(page, "Schlossberg");
    await clickAny(page, [".panel button:has-text('Log a find')", ".panel button:has-text('Log find')"]);
    await page.waitForTimeout(500);
    await shot(page, v.id, "logfind", "Log a find — verified by APRS");
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

  // Live stations layer + the station detail sheet (tap a station pin). Enable the layer in Search &
  // filter → Live layers, then click a station marker → StationPanel.
  await step("station", async () => {
    await closeAll(page);
    await clickAny(page, ["button[title='Filter by type']"]);
    await page.waitForSelector(".panel", { timeout: 6000 });
    await clickAny(page, [".panel label:has-text('Live stations') ~ * input", ".panel:has-text('Live stations') .switch input"]);
    // fall back: toggle the first switch under "Live layers"
    await page.evaluate(() => {
      const lbl = [...document.querySelectorAll(".panel label")].find((l) => /Live stations/.test(l.textContent || ""));
      const sw = lbl?.parentElement?.querySelector("input[type=checkbox], button[role=switch]");
      if (sw && sw.getAttribute("aria-checked") !== "true" && !sw.checked) sw.click();
    });
    await closeAll(page);
    await page.waitForSelector(".station-pin", { timeout: 8000 });
    // Click via the DOM, not Playwright's .click(): MapLibre markers get live transform updates from
    // the WS position stream, so actionability's "element is stable" wait can hang the full 30s. The
    // marker is a real <button>, so el.click() fires its React onClick regardless of motion/position.
    // Prefer a pin sitting inside the viewport (below the top bar) for a clean shot.
    const clicked = await page.evaluate(() => {
      const pins = [...document.querySelectorAll(".station-pin")];
      const inView = pins.find((p) => {
        const r = p.getBoundingClientRect();
        return r.top > 60 && r.left > 0 && r.bottom < innerHeight && r.right < innerWidth;
      });
      const el = inView || pins[0];
      el?.click();
      return !!el;
    });
    if (!clicked) throw new Error("no station pin to click");
    await page.waitForSelector(".panel:has-text('last heard'), .panel .logform", { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot(page, v.id, "station", "Station detail — track, telemetry & packets");
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
        // Instance-admin drawer: while it's freshly open, expand + shoot EACH operator group
        // (Federation / Forwarding / Ingest). Doing it here — not in a later step — avoids re-finding
        // the sysop entry after the settings openView reloads. (Settings has its own dedicated walk.)
        if (/^admin$/i.test(title)) await captureGroups(page, v.id, "admin", "Instance admin");
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

  // --- Workbench deep-dive: the launcher, the NET/ROM node + Tools plugins (real seeded app), then the
  // hardware/gated surfaces in demo mode (populated sims): GP packet terminal, BBS, CAT rig, remote box.
  await step("workbench", async () => {
    await openWorkbench(page);
    await page.waitForSelector(".wb-apps", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, v.id, "workbench-launcher", "Workbench — app launcher (pin to rail)");
  });
  // NET/ROM node is an OPERATOR-only app (administers the instance's server box) — hidden from the field
  // user's launcher, so it's captured only for an operator teaser (TEASER_ADMIN=1), never in public ones.
  if (process.env.TEASER_ADMIN === "1") {
    await step("node", async () => {
      await launchWbApp(page, "NET/ROM node", ".node-panel");
      await clickAny(page, [".node-panel button:has-text('NODES')"]); // reveal the NET/ROM node view
      await page.waitForTimeout(400);
      await shot(page, v.id, "node", "NET/ROM node · digipeater · sysop");
    });
  }
  await step("tools", async () => {
    await launchWbApp(page, "Tools", ".tools-panel");
    await shot(page, v.id, "tools", "Tools — sandboxed plugins");
  });
  await step("decoder", async () => {
    await launchWbApp(page, "Packet decoder", ".panel textarea");
    await clickAny(page, [".panel button:has-text('use a sample')"]);
    await clickAny(page, [".panel button:has-text('Decode')"]);
    await page.waitForTimeout(500);
    await shot(page, v.id, "decoder", "Packet decoder — raw AX.25 / APRS");
  });
  await step("packet", async () => {
    await gotoDemo(page, "app-packet", ".pt-window");
    await shot(page, v.id, "packet", "Packet terminal — Graphic Packet reborn");
  });
  await step("bbs", async () => {
    await gotoDemo(page, "app-bbs", ".bbs-body");
    await clickAny(page, [".bbs-row"]);                               // open the first thread → reply tree
    await page.waitForSelector(".bbs-thread, .bbs-read", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, v.id, "bbs", "BBS — mail, bulletins & threads");
  });
  await step("rig", async () => {
    await gotoDemo(page, "app-rig", ".rigctl");
    await clickAny(page, [".rigctl button:has-text('Connect rig')"]); // fake serial connects instantly
    await page.waitForSelector(".rigctl button:has-text('APRS')", { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, v.id, "rig", "Rig control — one-click CAT tune");
  });
  // Remote-box control is operator-only too — demo sim, captured only for an operator teaser.
  if (process.env.TEASER_ADMIN === "1") {
    await step("remote", async () => {
      await gotoDemo(page, "app-remote", ".logs");
      await shot(page, v.id, "remote", "Remote control — your ingest box");
    });
  }

  // Settings — expand EVERY group and screenshot it (exhaustive, self-maintaining: a new Settings
  // group is captured without editing this script). Signed in, so the account/profile/weather/
  // stations/notifications/data groups render; connections & network render regardless.
  await step("settings-groups", async () => {
    await openView(page, "settings", ".panel");
    await captureGroups(page, v.id, "set", "Settings");
  });


  // Operator "Instance Admin" surface — EXCLUDED from public teasers, captured only with TEASER_ADMIN=1
  // (which sets ADMIN_CALLSIGNS so the sysop entry renders). On desktop the rail walk above already
  // expanded + shot every operator group; this covers rail-hidden viewports via the top-bar 🛡. Never
  // publish an operator teaser.
  if (process.env.TEASER_ADMIN === "1" && !railVisible) {
    await step("admin-groups", async () => {
      await closeAll(page);
      const btn = page.locator('header .nav-desktop button[title^="Instance admin"]');
      await btn.waitFor({ state: "visible", timeout: 8000 });
      await btn.click();
      await page.waitForSelector(".panel", { timeout: 6000 });
      await captureGroups(page, v.id, "admin", "Instance admin");
    });
  }

  await ctx.close();
  await browser.close();
}

fs.writeFileSync(OUT + `manifest-${only ?? "all"}.json`, JSON.stringify(manifest, null, 2));
// Always emit a problems file (empty on a clean run) so run-tour.sh can aggregate and report failures
// at the end of a full run — a skipped step must be findable without grepping the whole log.
fs.writeFileSync(OUT + `problems-${only ?? "all"}.json`, JSON.stringify(problems, null, 2));
console.log(`\ntour complete (${only ?? "all"}): ${seq} frames, ${problems.length} skipped -> ${OUT}`);
if (problems.length) {
  console.log(`  problems (${problems.length}):`);
  for (const p of problems) console.log(`    ✗ ${p.viewport}/${p.step} — ${p.reason}`);
  process.exitCode = 4; // signal to run-tour.sh that steps were skipped (video still builds)
}
