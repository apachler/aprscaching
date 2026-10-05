#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * pnpm dev — the whole instance on one origin, reloading on every edit.
 *
 *   pnpm dev                 the gateway (Node + SQLite, restarts on a change) and the web app (Vite, hot reload)
 *   pnpm dev --ingest        also the ingest (APRS-IS, and any radio in the checkout's .env); DEV_INGEST=1 too
 *   pnpm dev:peer            also a second gateway that federates with the first, on 127.0.0.1:8788
 *   pnpm dev:preview         the production build, served by the gateway itself (service worker, offline
 *                            packs, prerendered landing); the build reruns on each change
 *   pnpm dev:admin [CALL]    a sign-in link for the admin call, and its operator verification once signed in
 *   pnpm dev:seed            load demo caches, stations, weather and messages into the running dev gateway
 *
 * The browser opens the Vite dev server, which hands every gateway path (isGatewayPath) to the gateway, the
 * live socket included: sessions, passkeys, sign-in links and media then work as on a real instance.
 * Settings and secrets live in .env.dev (written on the first run), data under .dev/.
 *
 * Options: --port <web> --gateway-port <port> --peer-port <port> --data <dir> --settings <file>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, fingerprint, gatewayEnv, ingestEnv, layout, loadDevEnv, peerEnv } from "./devenv.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args[0] && !args[0].startsWith("-") ? args[0] : "run";

const {
  file: envFile,
  created,
  vars,
} = await loadDevEnv({ file: opt("--settings") && path.resolve(opt("--settings")) });
const lay = layout(vars, {
  webPort: opt("--port"),
  gatewayPort: opt("--gateway-port"),
  peerPort: opt("--peer-port"),
  data: opt("--data"),
});
const gatewayUrl = `http://127.0.0.1:${lay.gateway}`;
const adminCall = (vars.ADMIN_CALLSIGNS ?? "").split(",")[0]?.trim() || "N0CALL";
/** A path for the banner: relative inside the checkout, absolute outside it. */
const shown = (p) => (path.relative(ROOT, p).startsWith("..") ? p : path.relative(ROOT, p) || ".");

const resolveIn = (pkgDir, spec) => createRequire(path.join(ROOT, pkgDir, "package.json")).resolve(spec);
const TSX = resolveIn("servers/node", "tsx/cli");
const VITE = path.join(path.dirname(resolveIn("apps/web", "vite/package.json")), "bin/vite.js");
const WEB_DIST = path.join(ROOT, "apps/web/dist");

const gatewayUp = () =>
  fetch(`${gatewayUrl}/health`).then(
    (r) => r.ok,
    () => false,
  );

/** A request with the operator secret, as tools/admin/*.mjs send it. */
async function operator(p, body) {
  const r = await fetch(gatewayUrl + p, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-secret": vars.OPERATOR_SECRET },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/**
 * Make `call` this instance's operator. A call no account holds yet gets the operator's one-time sign-in link
 * (an ADMIN_CALLSIGNS call opens no account by email or passkey without it); once the account exists, the
 * call is verified with the operator secret (POST /verify/operator), which opens Instance admin. With `wait`
 * it waits for the link to be used while `waiting()` holds. With `relink` an account that holds the call already
 * gets a fresh sign-in link too (an account the seed opened has no passkey or email yet). `say` reports each step;
 * true once verified.
 */
async function makeOperator(call, { wait, say, waiting = () => true, relink = false }) {
  const refused = (what, r) => {
    say(`${what} refused (${r.status}): ${r.data.error ?? "unexpected answer"}`);
    return false;
  };
  const preview = await operator("/verify/operator", { callsign: call, preview: true });
  if (!preview.ok) return refused("operator verify", preview);
  if (relink && preview.data.holder) {
    const link = await operator("/auth/operator-link", { callsign: call });
    if (!link.ok) return refused("sign-in link", link);
    say(`sign in as ${call} (single use, ${Math.round(link.data.expiresIn / 60)} minutes): ${link.data.link}`);
  }
  if (preview.data.verified && preview.data.holder) {
    say(`${call} is the operator: Instance admin is in the menu`);
    return true;
  }
  if (!preview.data.holder) {
    const link = await operator("/auth/operator-link", { callsign: call });
    if (!link.ok) return refused("sign-in link", link);
    say(`sign in as ${call} (single use, ${Math.round(link.data.expiresIn / 60)} minutes): ${link.data.link}`);
    if (!wait) return false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!waiting()) return false;
      const p = await operator("/verify/operator", { callsign: call, preview: true }).catch(() => null);
      if (p?.data.holder) break;
    }
  }
  const done = await operator("/verify/operator", { callsign: call });
  if (!done.ok) return refused("operator verify", done);
  say(`${call} is verified as the operator: reload the app, Instance admin is in the menu`);
  return true;
}

// ---------------------------------------------------------------- one-shot commands
if (command === "admin" || command === "seed") {
  if (!(await gatewayUp())) {
    console.error(`No dev gateway answers on ${gatewayUrl}: start it with pnpm dev first.`);
    process.exit(1);
  }
  if (command === "admin") {
    const call = (args[1] && !args[1].startsWith("-") ? args[1] : adminCall).toUpperCase();
    process.exit((await makeOperator(call, { wait: true, say: console.log, relink: true })) ? 0 : 1);
  }
  // the operator secret lets the seed open and verify the operator call the way dev:admin does
  const env = {
    ...process.env,
    API_BASE: gatewayUrl,
    INGEST_SECRET: vars.INGEST_SECRET,
    OPERATOR_SECRET: vars.OPERATOR_SECRET,
  };
  const child = spawn(process.execPath, ["tools/teaser/seed.mjs"], { cwd: ROOT, env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (command !== "run") {
  console.error(`unknown command ${command}: run, admin or seed`);
  process.exit(2);
} else {
  await run();
}

// ---------------------------------------------------------------- the stack
async function run() {
  const preview = flag("--preview");
  const withPeer = flag("--peer");
  const withIngest = flag("--ingest") || process.env.DEV_INGEST === "1" || vars.DEV_INGEST === "1";
  const appUrl = preview ? `http://localhost:${lay.gateway}` : `http://localhost:${lay.web}`;
  fs.mkdirSync(path.join(lay.data, "media"), { recursive: true });

  const children = [];
  let stopping = false;
  const COLORS = { gateway: 36, web: 35, ingest: 33, peer: 34, build: 32, dev: 37 };
  const tag = (name) => `\x1b[${COLORS[name] ?? 37}m${name.padEnd(7)}\x1b[0m│ `;
  const say = (line) => console.log(tag("dev") + line);

  /** Start a child in its own process group, its output prefixed with its name. */
  function start(name, argv, { cwd = ROOT, env = {}, onLine } = {}) {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (chunk) => {
        const lines = (rest + chunk.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          // a child's clear-screen would wipe the other children's lines
          process.stdout.write(tag(name) + line.replace(/\x1b\[[0-9;]*[HJ]/g, "") + "\n");
          onLine?.(line);
        }
      });
    }
    child.on("exit", (code, signal) => {
      if (stopping) return;
      say(`${name} exited (${signal ?? code}), stopping the rest`);
      void stop(code || 1);
    });
    children.push(child);
    return child;
  }

  function signalAll(signal) {
    for (const c of children) {
      if (c.exitCode !== null || c.signalCode !== null) continue;
      try {
        if (process.platform === "win32") c.kill(signal);
        else process.kill(-c.pid, signal);
      } catch {
        // already gone
      }
    }
  }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    signalAll("SIGTERM");
    const deadline = Date.now() + 5000;
    while (children.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    signalAll("SIGKILL");
    process.exit(code);
  }
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));

  // The gateway runs from source (every workspace package exports its src), so tsx watch restarts it on a
  // change to the gateway, the server, any package it imports, or a migration.
  const watch = [TSX, "watch", "--clear-screen=false", "--include", path.join(ROOT, "db/migrations"), "src/server.ts"];
  let mainEnv = gatewayEnv(vars, lay, { appUrl, webDist: preview ? WEB_DIST : undefined });
  if (withPeer)
    mainEnv = {
      FED_PEERS: `http://127.0.0.1:${lay.peer}#${await fingerprint(vars.DEV_PEER_FED_PRIVATE_KEY)}`,
      FED_CORROBORATION_QUORUM: "1",
      ...mainEnv,
    };

  if (preview) {
    // The watch build writes apps/web/dist again after each edit; the gateway starts once the first is done.
    let built;
    const firstBuild = new Promise((r) => (built = r));
    say("building the web app (production build, then again on each change)");
    start("build", [VITE, "build", "--watch"], {
      cwd: path.join(ROOT, "apps/web"),
      env: { VITE_API_BASE: "" },
      onLine: (line) => /built in/.test(line) && built(),
    });
    await firstBuild;
  }

  start("gateway", watch, { cwd: path.join(ROOT, "servers/node"), env: mainEnv });
  if (!preview)
    start("web", [VITE, "--port", String(lay.web), "--strictPort"], {
      cwd: path.join(ROOT, "apps/web"),
      env: { DEV_GATEWAY: gatewayUrl, VITE_API_BASE: "" },
    });
  if (withPeer) {
    fs.mkdirSync(path.join(lay.data, "peer", "media"), { recursive: true });
    const mainFingerprint = await fingerprint(vars.FED_PRIVATE_KEY);
    start("peer", watch, {
      cwd: path.join(ROOT, "servers/node"),
      env: peerEnv(vars, lay, { mainFingerprint, webDist: fs.existsSync(WEB_DIST) ? WEB_DIST : undefined }),
    });
  }
  if (withIngest)
    start("ingest", [TSX, "watch", "--clear-screen=false", "src/index.ts"], {
      cwd: path.join(ROOT, "apps/ingest"),
      env: ingestEnv(vars, lay),
    });

  for (let i = 0; i < 120 && !stopping && !(await gatewayUp()); i++) await new Promise((r) => setTimeout(r, 500));
  console.log(
    [
      "",
      `  aprscaching dev      ${appUrl}`,
      `  admin call           ${adminCall}`,
      `  settings             ${shown(envFile)}${created ? "  (new)" : ""}`,
      `  data                 ${shown(lay.data)}`,
      preview ? "  web app              production build, rebuilt on each change: reload the page" : null,
      withPeer ? `  peer instance        http://127.0.0.1:${lay.peer}  (federates with this one)` : null,
      withIngest ? `  ingest               APRS-IS filter ${vars.APRSIS_FILTER || "from .env"}` : null,
      "  Ctrl-C stops everything.",
      "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
  // the admin call's sign-in link while no account holds it, and its operator verification once one does
  await makeOperator(adminCall, { wait: true, say, waiting: () => !stopping }).catch((e) =>
    say(`operator setup: ${e.message}`),
  );
}
