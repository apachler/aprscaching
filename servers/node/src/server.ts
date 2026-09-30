// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * aprscaching node-gateway — the portable self-host runtime.
 *
 * Same handlers as the Cloudflare Worker (imported from @aprscaching/gateway/app), wired to:
 *   • SQLite via a D1-compatible shim (d1.ts)   • in-memory region rooms over `ws` (rooms.ts)
 *   • a node:http <-> Web Request/Response bridge • a nightly TTL interval
 *
 * Run: `pnpm --filter @aprscaching/node-gateway start`  (env: PORT, DB_PATH, INGEST_SECRET, OPERATOR_SECRET, …)
 * WEB_DIST (the built apps/web/dist) makes it serve the SPA on the same origin too, with no proxy in front.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";
import { handle, isGatewayPath } from "@aprscaching/gateway/app";
import { federationConfigError } from "@aprscaching/gateway/federation";
import { stampClientIp } from "@aprscaching/gateway/corroborate_privacy";
import { stringEnvFrom, type Env } from "@aprscaching/gateway/env";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { resolveServerSecrets } from "./secrets.js";
import { makeD1 } from "./d1.js";
import { migrate } from "./migrate.js";
import { joinRoom } from "./rooms.js";
import { makeFsMedia } from "./media.js";
import { spaFile } from "./spa.js";
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

// ---- node:http <-> Web Request/Response ----
const server = http.createServer(async (nreq, nres) => {
  try {
    const url = `http://${nreq.headers.host ?? "localhost"}${nreq.url ?? "/"}`;
    const method = nreq.method ?? "GET";
    if (WEB_DIST && (method === "GET" || method === "HEAD")) {
      const pathname = new URL(url).pathname;
      if (!isGatewayPath(pathname)) {
        sendSpa(nres, spaFile(WEB_DIST, pathname), method);
        return;
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    // The socket address is the ONLY client identity we mint ourselves — overwrite any client-supplied
    // x-real-ip, and drop a client-sent cf-connecting-ip unless a Cloudflare edge is declared (TRUST_CF).
    stampClientIp(headers, nreq.socket.remoteAddress, env);
    const hasBody = method !== "GET" && method !== "HEAD";
    // readBody returns raw bytes — the gateway speaks JSON on most routes but BINARY on the
    // federation wire (CBOR sync pages, beacon datagrams); a utf8 round-trip would corrupt those.
    const request = new Request(url, { method, headers, body: hasBody ? await readBody(nreq) : undefined });
    const response = await handle(request, env, { waitUntil: (p) => void p.catch(() => {}) });

    nres.statusCode = response.status;
    response.headers.forEach((value, key) => nres.setHeader(key, value));
    // Server-Sent Events (the CoT push feed) are long-lived — pipe the body chunk-by-chunk instead
    // of buffering to completion (which would hold every event until the stream closed, defeating SSE).
    if (response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      nreq.socket.setTimeout(0); // no idle timeout on a streaming connection
      const reader = response.body.getReader();
      nres.on("close", () => void reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!nres.write(Buffer.from(value))) await new Promise((r) => nres.once("drain", r));
      }
      nres.end();
    } else {
      nres.end(Buffer.from(await response.arrayBuffer()));
    }
  } catch (e) {
    nres.statusCode = e instanceof BodyTooLarge ? 413 : 500;
    nres.setHeader("content-type", "application/json");
    nres.end(JSON.stringify({ error: (e as Error).message }));
  }
});

/** One file of the built SPA, or a 404 when nothing in the build answers the path. */
function sendSpa(nres: http.ServerResponse, f: ReturnType<typeof spaFile>, method: string): void {
  if (!f) {
    nres.statusCode = 404;
    nres.setHeader("content-type", "text/plain; charset=utf-8");
    nres.end("not found");
    return;
  }
  nres.statusCode = 200;
  nres.setHeader("content-type", f.contentType);
  nres.setHeader("cache-control", f.cacheControl);
  nres.setHeader("x-content-type-options", "nosniff");
  if (method === "HEAD") {
    nres.end();
    return;
  }
  fs.createReadStream(f.file)
    .on("error", () => nres.destroy())
    .pipe(nres);
}

// ---- websocket upgrade (region rooms) ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (u.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const region = u.searchParams.get("region") ?? "global";
  wss.handleUpgrade(req, socket, head, (ws) => joinRoom(rooms, region, ws));
});

server.listen(PORT, () =>
  console.log(
    `aprscaching node-gateway listening on :${PORT}  (db: ${DB_PATH})${WEB_DIST ? `  (web: ${WEB_DIST})` : ""}`,
  ),
);

startSchedules(env, fedSyncInterval(process.env));

/** The bridge buffers the whole body BEFORE routing/auth, so without a ceiling one
 *  multi-GB anonymous POST OOMs the Pi. 20 MB clears every legitimate payload (the largest is a
 *  cache-media upload); past it the socket is destroyed and the request answered 413. */
const BODY_MAX_BYTES = 20 * 1024 * 1024;
class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}
function readBody(req: http.IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      total += (c as Buffer).length;
      if (total > BODY_MAX_BYTES) {
        req.destroy();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => resolve(Uint8Array.from(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

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
