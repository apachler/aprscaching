#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * pnpm dev:check — boots the development stack (tools/dev/dev.mjs) on free ports with throwaway settings
 * and data, and proves that everything reaches the gateway through the dev server's one origin:
 *
 *   the page and Vite's hot-reload socket · an API call · a sign-in by email link (dev token) and the
 *   session cookie it sets · the operator verify (pnpm dev:verify) and an admin-only route · hiding a cache,
 *   adding a photo and logging a find · the live WebSocket, with a packet posted to /ingest arriving on it ·
 *   a passkey registration and sign-in with Chromium's virtual authenticator.
 *
 * Browser resolution: $CHROMIUM_PATH, then playwright-core's registry (`pnpm exec playwright-core install
 * chromium`). Exits non-zero on the first failed step and prints the stack's log tail.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { ROOT, parseEnv } from "./devenv.mjs";

const CALL = "OE8TST";
const ADMIN = "OE8ADM";
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    // no registry browser
  }
  return null;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "acs-dev-check-"));
const settings = path.join(tmp, "env.dev");
const web = await freePort();
const gateway = await freePort();
const ORIGIN = `http://localhost:${web}`;
const ports = ["--port", String(web), "--gateway-port", String(gateway), "--data", path.join(tmp, "data")];

let log = "";
const stack = spawn(process.execPath, ["tools/dev/dev.mjs", ...ports, "--settings", settings], {
  cwd: ROOT,
  env: { ...process.env, DEV_CALL: ADMIN, DEV_INGEST: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
stack.stdout.on("data", (c) => (log += c));
stack.stderr.on("data", (c) => (log += c));

let browser;
let failed = false;
async function teardown() {
  await browser?.close().catch(() => {});
  if (stack.exitCode === null) {
    stack.kill("SIGTERM");
    await new Promise((r) => stack.once("exit", r));
  }
  rmSync(tmp, { recursive: true, force: true });
}

function step(name, ok, detail = "") {
  if (ok) {
    console.log(`✓ ${name}`);
    return;
  }
  failed = true;
  throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
}

const call = (p, init = {}) => fetch(ORIGIN + p, init);
const jsonOf = async (r) => r.json().catch(() => ({}));

try {
  // ---- the stack answers on the dev server's origin
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await call("/health").then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  step("gateway answers through the dev server (/health)", up);
  const vars = parseEnv(readFileSync(settings, "utf8"));
  const page = await call("/");
  const html = await page.text();
  step("the page loads from Vite", page.ok && html.includes("/@vite/client"));
  const stats = await call("/api/v1/stats");
  step("an API call reaches the gateway (/api/v1/stats)", stats.ok && "caches" in (await jsonOf(stats)));

  // ---- sign-in by email link: the dev token comes back in-band and names the dev server's origin
  const start = await jsonOf(
    await call("/auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "oe8tst@dev.localhost", callsign: CALL }),
    }),
  );
  step(
    "email sign-in hands back a dev link on this origin",
    String(start.devLink).startsWith(`${ORIGIN}/auth/`),
    JSON.stringify(start),
  );
  const verify = await call("/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ token: start.devToken }),
  });
  const cookie = /(acs=[^;]+)/.exec(verify.headers.get("set-cookie") ?? "")?.[1];
  step("the link signs in and sets the session cookie", verify.ok && !!cookie);
  const authed = { cookie, origin: ORIGIN };
  const session = await jsonOf(await call("/auth/session", { headers: authed }));
  step("the session cookie is honoured", session.callsign === CALL, JSON.stringify(session));

  // ---- the operator: pnpm dev prints the admin call's sign-in link, and verifies the call once it is used
  const opLink = /sign in as \S+ .*?: (http\S+)/.exec(log.replace(/\x1b\[[0-9;]*m/g, ""))?.[1];
  step("pnpm dev prints the admin call's sign-in link on this origin", !!opLink?.startsWith(`${ORIGIN}/auth/`), log);
  const opVerify = await call("/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ token: new URL(opLink).searchParams.get("token") }),
  });
  const opCookie = /(acs=[^;]+)/.exec(opVerify.headers.get("set-cookie") ?? "")?.[1];
  step("the operator link signs the admin call in", opVerify.ok && !!opCookie);
  for (let i = 0; i < 50 && !log.includes("verified as the operator"); i++)
    await new Promise((r) => setTimeout(r, 100));
  step("pnpm dev verifies the admin call as operator", log.includes("verified as the operator"));
  const operatorAuth = { cookie: opCookie, origin: ORIGIN };
  const admin = await call("/api/admin/setup", { headers: operatorAuth });
  step("Instance admin answers the operator", admin.ok, String(admin.status));
  const notAdmin = await call("/api/admin/setup", { headers: authed });
  step("Instance admin refuses a player", notAdmin.status === 403, String(notAdmin.status));

  // ---- the operator hides a cache and adds a photo; the player logs a find
  const created = await jsonOf(
    await call("/api/caches", {
      method: "POST",
      headers: { ...operatorAuth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Dev stack check", lat: 47.07, lon: 15.44 }),
    }),
  );
  const cacheId = created.id ?? created.cache?.id;
  step("hiding a cache works", Number.isInteger(cacheId), JSON.stringify(created));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const media = await jsonOf(
    await call(`/api/caches/${cacheId}/media?title=check`, {
      method: "POST",
      headers: { ...operatorAuth, "content-type": "image/png" },
      body: png,
    }),
  );
  const photo = media.item?.url ? await call(media.item.url) : null;
  step("a photo uploads and is served back", !!photo?.ok, JSON.stringify(media));
  const found = await call(`/api/caches/${cacheId}/logs`, {
    method: "POST",
    headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({
      logType: "found",
      comment: "dev check",
      appGeo: { lat: 47.07, lon: 15.44, accuracyM: 10, ts: Math.floor(Date.now() / 1000) },
    }),
  });
  step("logging a find works", found.ok, `${found.status} ${await found.text()}`);

  // ---- the live socket through the proxy, and a packet arriving on it
  const ws = new WebSocket(`ws://localhost:${web}/ws?region=global`);
  const opened = await new Promise((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 5000);
  });
  step("the live WebSocket connects through the dev server", opened);
  ws.send(JSON.stringify({ type: "subscribe", bbox: [15, 47, 16, 48] }));
  await new Promise((r) => setTimeout(r, 300));
  const live = new Promise((resolve) => {
    ws.onmessage = (e) => resolve(String(e.data));
    setTimeout(() => resolve(null), 8000);
  });
  await call("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": vars.INGEST_SECRET },
    body: JSON.stringify({
      packets: [
        {
          src: "OE8TST-9",
          dst: "APRS",
          path: ["WIDE1-1"],
          payload: "=4704.20N/01526.40E>dev check",
          heardVia: "aprs_is",
          port: "aprs-is",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    }),
  });
  const message = await live;
  step("an ingested packet arrives on the live socket", !!message?.includes("OE8TST-9"), String(message));
  ws.close();

  // ---- a passkey, in Chromium with a virtual authenticator, on the dev server's origin
  const executablePath = findChromium();
  if (!executablePath)
    throw new Error("no Chromium: set CHROMIUM_PATH or run pnpm exec playwright-core install chromium");
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const tab = await ctx.newPage();
  const consoleLines = [];
  tab.on("console", (m) => consoleLines.push(m.text()));
  const cdp = await ctx.newCDPSession(tab);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await tab.goto(ORIGIN + "/", { waitUntil: "load" });
  for (let i = 0; i < 50 && !consoleLines.some((l) => l.includes("[vite] connected")); i++)
    await tab.waitForTimeout(100);
  step(
    "Vite's hot-reload socket connects past the proxy",
    consoleLines.some((l) => l.includes("[vite] connected")),
  );
  const harness = readFileSync(path.join(ROOT, "tools/webauthn/harness.html"), "utf8");
  await tab.addScriptTag({ content: /<script>([\s\S]*)<\/script>/.exec(harness)[1] });
  const passkeyCall = "OE8PKY";
  const reg = await tab.evaluate((cs) => window.acReg("", cs), passkeyCall);
  step("passkey registration completes", reg.status === 200 && reg.body?.ok, JSON.stringify(reg));
  await tab.evaluate(() => fetch("/auth/logout", { method: "POST" }));
  const login = await tab.evaluate((cs) => window.acLogin("", cs, false), passkeyCall);
  step("passkey sign-in completes", login.status === 200 && login.body?.ok, JSON.stringify(login));
  const me = await tab.evaluate(() => fetch("/auth/session").then((r) => r.json()));
  step("the browser holds the passkey session", me.callsign === passkeyCall, JSON.stringify(me));
  console.log("✓ dev stack check passed");
} catch (e) {
  failed = true;
  console.error(`✗ ${e.message}`);
  console.error("--- stack log tail ---");
  console.error(log.split("\n").slice(-30).join("\n"));
} finally {
  await teardown();
}
process.exit(failed ? 1 : 0);
