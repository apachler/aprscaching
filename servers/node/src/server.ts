// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * aprscaching node-gateway — the portable self-host runtime.
 *
 * Same handlers as the Cloudflare Worker (imported from @aprscaching/gateway/app), wired to:
 *   • SQLite via a D1-compatible shim (d1.ts)   • in-memory region rooms over `ws` (rooms.ts)
 *   • a node:http(s) <-> Web Request/Response bridge (listen.ts) • a nightly TTL interval
 *
 * Run: `pnpm --filter @aprscaching/node-gateway start`  (env: PORT, DB_PATH, INGEST_SECRET, OPERATOR_SECRET, …)
 * WEB_DIST (the built apps/web/dist) makes it serve the SPA on the same origin too, with no proxy in front.
 * HTTPS_PORT with TLS_CERT/TLS_KEY adds an https listener beside the plain one (listen.ts); SIGHUP reloads
 * its certificate.
 */
import type https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
// listen.ts loads the gateway's app module, which must evaluate before any of its submodules below:
// the gateway's modules import each other in a cycle that only resolves from app's side.
import { createGatewayServer, readTls, reloadTls, tlsFromEnv } from "./listen.js";
import { federationConfigError } from "@aprscaching/gateway/federation";
import { stringEnvFrom, type Env } from "@aprscaching/gateway/env";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { resolveServerSecrets } from "./secrets.js";
import { makeD1 } from "./d1.js";
import { migrate } from "./migrate.js";
import { makeFsMedia } from "./media.js";
import {
  fedSyncInterval,
  gitHead,
  guardFederationFetches,
  logStrayErrors,
  roomNamespace,
  startSchedules,
} from "./host.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787; // a blank/NaN PORT must not bind port 0
const DB_PATH = process.env.DB_PATH ?? path.resolve(HERE, "../data/aprscaching.db");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(HERE, "../../../db/migrations");
const MEDIA_DIR = process.env.MEDIA_DIR ?? path.resolve(HERE, "../data/media");
const WEB_DIST = process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : undefined;

// Boot guards: a strong INGEST_SECRET, an OPERATOR_SECRET of its own if set, and SESSION_SECRET from
// the environment or generated once and kept beside the database (so a single box needs no setup).
const SECRETS = resolveServerSecrets(process.env, path.dirname(DB_PATH));
if (!SECRETS.ok) {
  console.error(`FATAL: ${SECRETS.error}`);
  process.exit(1);
}
if (SECRETS.sessionSource === "generated") console.log(`SESSION_SECRET generated and kept in ${path.dirname(DB_PATH)}`);

// Boot guard: HTTPS_PORT needs its certificate and key; a half-configured listener must not boot as plain http.
const TLS_CONFIG = tlsFromEnv(process.env);
if (!TLS_CONFIG.ok) {
  console.error(`FATAL: ${TLS_CONFIG.error}`);
  process.exit(1);
}
const TLS = TLS_CONFIG.tls;

// Boot guard: a registry whose authority key is not pinned cannot be verified, and federation
// would otherwise run on whatever DNS says. Refuse to start instead of failing open.
const fedConfigError = federationConfigError(process.env as unknown as Env);
if (fedConfigError) {
  console.error(`FATAL: ${fedConfigError}`);
  process.exit(1);
}

// ---- storage ----
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const ran = migrate(sqlite, MIGRATIONS_DIR);
console.log(ran.length ? `migrations applied: ${ran.join(", ")}` : "migrations up to date");

// ---- env (runtime-neutral bindings) ----
const rooms = new RoomsCore();
const env: Env = {
  DB: makeD1(sqlite),
  TILES: {}, // reserved seam (offline tile packs)
  MEDIA: makeFsMedia(MEDIA_DIR),
  ROOMS: roomNamespace(rooms),
  ...stringEnvFrom(process.env), // forward EVERY config key, not a hand-picked subset
  ...SECRETS.secrets, // the checked ingest/operator secrets and the resolved session secret
  // AGPL §13 source: commit from env, else git (self-host-from-source)
  SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? gitHead(),
};
guardFederationFetches(env);

// ---- listeners: plain http, and https beside it when HTTPS_PORT is set ----
const TLS_CA_CERT = process.env.TLS_CA_CERT?.trim() || undefined;
const listenerBase = { env, rooms, webDist: WEB_DIST, caCert: TLS_CA_CERT };
let secure: https.Server | undefined;
if (TLS) {
  let pair: ReturnType<typeof readTls>;
  try {
    pair = readTls(TLS);
  } catch (e) {
    console.error(`FATAL: cannot read TLS_CERT/TLS_KEY: ${(e as Error).message}`);
    process.exit(1);
  }
  env.HTTPS_LISTENER_PORT = String(TLS.port);
  secure = createGatewayServer({ ...listenerBase, tls: pair }) as https.Server;
  secure.listen(TLS.port, () => console.log(`aprscaching node-gateway https on :${TLS.port}`));
  // A re-issued certificate (a hotspot that came back on another address) loads without a restart.
  process.on("SIGHUP", () => {
    try {
      reloadTls(secure!, TLS);
      console.log("SIGHUP — TLS certificate reloaded");
    } catch (e) {
      console.error(`SIGHUP — TLS certificate not reloaded, the previous one stays: ${(e as Error).message}`);
    }
  });
}
const server = createGatewayServer({ ...listenerBase, httpsPort: TLS?.port });

server.listen(PORT, () =>
  console.log(
    `aprscaching node-gateway listening on :${PORT}  (db: ${DB_PATH})${WEB_DIST ? `  (web: ${WEB_DIST})` : ""}`,
  ),
);

startSchedules(env, fedSyncInterval(process.env));

// ---- 24/7 process resilience ----
// One stray rejection must not kill an unattended gateway (there is no supervisor on a Pi by
// default): log and keep serving. SIGTERM/SIGINT close the listener, checkpoint SQLite (WAL) and
// exit cleanly so systemd/docker stops are never data-lossy.
logStrayErrors();
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing gateway`);
  secure?.close();
  server.close(() => {
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      sqlite.close();
    } catch (e) {
      console.error("db close:", e);
    }
    process.exit(0);
  });
  // a hung in-flight request must not block shutdown forever
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
