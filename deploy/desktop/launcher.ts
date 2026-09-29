#!/usr/bin/env bun
/**
 * aprscaching desktop launcher — the single-binary, all-in-one desktop entry (gateway + SPA).
 * Compiled with `bun build --compile` (see build-exe.sh): one file that starts the Bun gateway
 * (servers/bun/server.ts, the server the Bun conformance lane tests), serves the embedded SPA, keeps
 * SQLite in the OS app-data dir, and opens the browser. RF comes from the **browser (Web Serial/BLE)** —
 * operator-local, per .claude/rules/ingest-locality.md; an always-on local ingest is run separately
 * (apps/ingest) when wanted. Off-grid by default.
 *
 * It listens on 127.0.0.1 only; HOST=0.0.0.0 (or a LAN address) opts into serving the local network.
 * Its ingest, operator and session secrets are generated on first run and kept in the app-data dir
 * (`ingest.secret`, `operator.secret`, `session.secret`) unless the environment sets them — there is no
 * built-in default anyone could know. Every other setting is read from the environment, as on the servers.
 *
 * Assets (SPA + migrations) are embedded via assets.generated.ts when compiled; in dev (plain
 * `bun run launcher.ts`) it falls back to reading apps/web/dist + db/migrations from disk.
 */
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appDataDir } from "./appdata.ts";
import { createServer, type BunServer } from "../../servers/bun/server.ts";
import { migrationsFromDir } from "../../servers/node/src/migrate.ts";
import { resolveInstanceSecrets } from "../../servers/node/src/secrets.ts";

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "dev";
const PORT = Number(process.env.PORT) || 8787;
/** Loopback unless the operator opts into the LAN with HOST. */
const HOST = process.env.HOST || "127.0.0.1";
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- assets: embedded (compiled) or disk (dev) ----
let SPA: Record<string, string> = {};
let MIGRATIONS: { name: string; sql: string }[] = [];
try {
  const gen = (await import("./assets.generated.ts")) as {
    SPA?: Record<string, string>;
    MIGRATIONS?: { name: string; file: string }[];
  };
  SPA = gen.SPA ?? {};
  MIGRATIONS = await Promise.all(
    (gen.MIGRATIONS ?? []).map(async (m) => ({ name: m.name, sql: await Bun.file(m.file).text() })),
  );
} catch {
  /* dev: no embed manifest → fall back to disk below */
}

const embedded = Object.keys(SPA).length > 0;
const WEB_DIST = process.env.WEB_DIST ?? join(HERE, "../../apps/web/dist");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(HERE, "../../db/migrations");
if (MIGRATIONS.length === 0 && existsSync(MIGRATIONS_DIR)) MIGRATIONS = migrationsFromDir(MIGRATIONS_DIR);

// ---- storage (app-data dir) ----
const dir = process.env.DATA_DIR ?? appDataDir("aprscaching");
mkdirSync(dir, { recursive: true });

// ---- secrets: each from the environment, else generated once and kept in the app-data dir ----
const resolved = resolveInstanceSecrets(process.env, dir);
if (!resolved.ok) {
  console.error(`aprscaching: ${resolved.error}`);
  process.exit(1);
}

// ---- SPA serving ----
const CT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain",
  pmtiles: "application/octet-stream",
  wasm: "application/wasm",
};
const ctOf = (p: string) => CT[p.slice(p.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

function serveSpa(pathname: string): Response {
  const p = pathname === "/" ? "/index.html" : pathname;
  if (embedded) {
    const file = SPA[p] ?? SPA["/index.html"]; // SPA-router fallback
    return new Response(Bun.file(file), { headers: { "content-type": ctOf(SPA[p] ? p : "/index.html") } });
  }
  const fp = join(WEB_DIST, p.replace(/^\/+/, ""));
  if (!fp.startsWith(WEB_DIST)) return new Response("bad path", { status: 400 });
  if (existsSync(fp)) return new Response(Bun.file(fp), { headers: { "content-type": ctOf(fp) } });
  return new Response(Bun.file(join(WEB_DIST, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---- the gateway: every route app.ts serves goes to it, everything else is the SPA ----
let started: BunServer;
try {
  started = createServer({
    environment: process.env,
    hostname: HOST,
    port: PORT,
    dbPath: join(dir, "aprscaching.db"),
    mediaDir: join(dir, "media"),
    migrations: MIGRATIONS,
    secrets: resolved.secrets,
    // AGPL §13 source link: the build stamps BUILD_VERSION (git describe) as the commit/tag
    sourceCommit: VERSION !== "dev" ? VERSION : undefined,
    spa: serveSpa,
  });
} catch (e) {
  console.error(`aprscaching: ${(e as Error).message}`);
  process.exit(1);
}
const { server, migrated } = started;

// open the address actually bound: "localhost" may resolve to ::1, which a 127.0.0.1 listener does not answer
const openHost = HOST === "0.0.0.0" || HOST.includes(":") ? "127.0.0.1" : HOST;
const localUrl = `http://${openHost}:${server.port}`;
console.log(
  `aprscaching ${VERSION} → ${localUrl}   (listening on ${HOST}; data: ${dir}${migrated.length ? `, ${migrated.length} migrations applied` : ""}${embedded ? ", embedded assets" : ", disk assets"})`,
);
console.log(
  `secrets: ingest.secret, operator.secret and session.secret in ${dir} (an ingest box or tools/admin/* needs them)`,
);
openBrowser(localUrl);

function openBrowser(u: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", u]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", u]
        : ["xdg-open", u];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* headless: ignore */
  }
}
