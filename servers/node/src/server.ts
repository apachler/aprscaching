// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * aprscaching node-gateway — the portable self-host runtime.
 *
 * Same handlers as the Cloudflare Worker (imported from @aprsweb/gateway/app), wired to:
 *   • SQLite via a D1-compatible shim (d1.ts)   • in-memory region rooms over `ws` (rooms.ts)
 *   • a node:http <-> Web Request/Response bridge • a nightly TTL interval
 *
 * Run: `pnpm --filter @aprsweb/node-gateway start`  (env: PORT, DB_PATH, INGEST_SECRET, …)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";
import { handle, runScheduled, syncAllPeers } from "@aprsweb/gateway/app";
import { stringEnvFrom, type Env } from "@aprsweb/gateway/env";
import { makeD1 } from "./d1.js";
import { migrate } from "./migrate.js";
import { Rooms } from "./rooms.js";
import { makeFsMedia } from "./media.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787; // SR-CFG-02: a blank/NaN PORT must not bind port 0
const DB_PATH = process.env.DB_PATH ?? path.resolve(HERE, "../data/aprscaching.db");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(HERE, "../../../db/migrations");
const MEDIA_DIR = process.env.MEDIA_DIR ?? path.resolve(HERE, "../data/media");
const INGEST_SECRET = process.env.INGEST_SECRET ?? "";

// SR-SEC-01 boot guard: the session-signing key derives from this secret; booting with the
// known default would let anyone forge a session cookie for any callsign (incl. the sysop).
if (!INGEST_SECRET || INGEST_SECRET === "change-me") {
  console.error(
    "FATAL: INGEST_SECRET is unset or still the 'change-me' default.\n" +
      "  Set a strong secret, e.g.:  INGEST_SECRET=$(openssl rand -hex 24)\n" +
      "  (optionally also SESSION_SECRET to decouple user sessions from the ingest credential)",
  );
  process.exit(1);
}

// ---- storage ----
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const ran = migrate(sqlite, MIGRATIONS_DIR);
console.log(ran.length ? `migrations applied: ${ran.join(", ")}` : "migrations up to date");

// ---- AGPL §13 source (ADR-3): commit from env, else git (self-host-from-source) ----
function gitHead(): string | undefined {
  try {
    return (
      execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}
const SOURCE = {
  SOURCE_REPO: process.env.SOURCE_REPO,
  SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? gitHead(),
  SOURCE_TAG: process.env.SOURCE_TAG,
  SOURCE_BUILT_AT: process.env.SOURCE_BUILT_AT,
};

// ---- env (runtime-neutral bindings) ----
const rooms = new Rooms();
const env: Env = {
  DB: makeD1(sqlite),
  TILES: {}, // R2 unused in M1
  MEDIA: makeFsMedia(MEDIA_DIR),
  ROOMS: {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (req: Request) => {
        // live dispatch from /ingest; the WS upgrade itself is handled below
        if (req.method === "POST") {
          const { envelopes } = (await req.json()) as { envelopes: import("@aprsweb/gateway/live").LiveEnvelope[] };
          rooms.dispatch(String(id), envelopes);
          return new Response(null, { status: 204 });
        }
        return new Response("expected websocket upgrade", { status: 426 });
      },
    }),
  },
  INGEST_SECRET,
  ...stringEnvFrom(process.env), // SR-RT-03: forward EVERY config key, not a hand-picked subset
  ...SOURCE, // host-resolved SOURCE_* (git HEAD fallback) wins over the raw env
};

// ---- node:http <-> Web Request/Response ----
const server = http.createServer(async (nreq, nres) => {
  try {
    const url = `http://${nreq.headers.host ?? "localhost"}${nreq.url ?? "/"}`;
    const method = nreq.method ?? "GET";
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    // SR-SEC-09: the socket address is the ONLY client identity we mint ourselves — overwrite
    // any client-supplied x-real-ip so rate-limit keying can trust it.
    headers.set("x-real-ip", nreq.socket.remoteAddress ?? "unknown");
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, { method, headers, body: hasBody ? await readBody(nreq) : undefined });
    // (readBody returns a string; the gateway API is JSON throughout)
    const response = await handle(request, env, { waitUntil: (p) => void p.catch(() => {}) });

    nres.statusCode = response.status;
    response.headers.forEach((value, key) => nres.setHeader(key, value));
    nres.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    nres.statusCode = e instanceof BodyTooLarge ? 413 : 500;
    nres.setHeader("content-type", "application/json");
    nres.end(JSON.stringify({ error: (e as Error).message }));
  }
});

// ---- websocket upgrade (region rooms) ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (u.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const region = u.searchParams.get("region") ?? "global";
  wss.handleUpgrade(req, socket, head, (ws) => rooms.join(region, ws));
});

server.listen(PORT, () => console.log(`aprscaching node-gateway listening on :${PORT}  (db: ${DB_PATH})`));

// nightly TTL of firehose positions (logger positions kept longer for verification).
// SR-RT-02: run once at startup too — a Pi that reboots more often than daily would otherwise never
// prune, so the DB only grows. Idempotent (the digests mark alerts notified; the deletes are bounded).
const runTtl = () => void runScheduled(env).catch((e) => console.error("scheduled:", e));
runTtl();
setInterval(runTtl, 24 * 3600 * 1000);

// pull from federation peers on an interval (default 5 min; only if peers are configured)
const FED_SYNC_MS = Number(process.env.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
if (env.FED_PEERS && FED_SYNC_MS > 0) {
  setInterval(() => void syncAllPeers(env).catch((e) => console.error("federation sync:", e)), FED_SYNC_MS);
}

/** SR-RT-10: the bridge buffers the whole body BEFORE routing/auth, so without a ceiling one
 *  multi-GB anonymous POST OOMs the Pi. 20 MB clears every legitimate payload (the largest is a
 *  cache-media upload); past it the socket is destroyed and the request answered 413. */
const BODY_MAX_BYTES = 20 * 1024 * 1024;
class BodyTooLarge extends Error {
  constructor() {
    super("request body too large");
  }
}
function readBody(req: http.IncomingMessage): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- SR-RT-11: 24/7 process resilience ----
// One stray rejection must not kill an unattended gateway (there is no supervisor on a Pi by
// default): log and keep serving. SIGTERM/SIGINT close the listener, checkpoint SQLite (WAL) and
// exit cleanly so systemd/docker stops are never data-lossy.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
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
