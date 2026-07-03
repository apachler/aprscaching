#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * aprscaching bun-gateway — the Bun-runtime self-host / single-binary core (Topology 0).
 *
 * Same handlers as the Cloudflare Worker and the Node server (imported from @aprsweb/gateway/app),
 * wired to: bun:sqlite via the D1-compatible shim (./d1.ts) · in-memory region rooms over Bun.serve
 * WebSockets (./rooms.ts) · a filesystem MediaStore (./media.ts). Bun.serve speaks Web Request/
 * Response natively, so handle() is called directly with no http bridge.
 *
 * Run: `bun run servers/bun/server.ts`  (env: PORT, DB_PATH, MIGRATIONS_DIR, MEDIA_DIR, INGEST_SECRET, …)
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { handle, runScheduled, syncAllPeers } from "@aprsweb/gateway/app";
import { stringEnvFrom, type Env } from "@aprsweb/gateway/env";
import type { LiveEnvelope } from "@aprsweb/gateway/live";
import { BunDb } from "./d1.ts";
import { migrate } from "./migrate.ts";
import { makeFsMedia } from "./media.ts";
import { BunRooms, type WsData } from "./rooms.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787; // SR-CFG-02: a blank/NaN PORT must not bind port 0
const DB_PATH = process.env.DB_PATH ?? join(HERE, "data/aprscaching.db");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(HERE, "../../db/migrations");
const MEDIA_DIR = process.env.MEDIA_DIR ?? join(HERE, "data/media");
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

// ---- storage ----
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new BunDb(DB_PATH);
const ran = migrate(db.raw, MIGRATIONS_DIR);
console.log(ran.length ? `migrations applied: ${ran.join(", ")}` : "migrations up to date");

// ---- env (runtime-neutral bindings) ----
const rooms = new BunRooms();
const env: Env = {
  DB: db,
  TILES: {},
  MEDIA: makeFsMedia(MEDIA_DIR),
  ROOMS: {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (req: Request) => {
        // live dispatch from /ingest; the WS upgrade itself is handled in Bun.serve below
        if (req.method === "POST") {
          const { envelopes } = (await req.json()) as { envelopes: LiveEnvelope[] };
          rooms.dispatch(String(id), envelopes);
          return new Response(null, { status: 204 });
        }
        return new Response("expected websocket upgrade", { status: 426 });
      },
    }),
  },
  INGEST_SECRET,
  ...stringEnvFrom(process.env), // SR-RT-03: forward EVERY config key (Bun previously lacked ADMIN_CALLSIGNS etc.)
  // AGPL §13 source (ADR-3): commit from env, else git (self-host-from-source) — the resolved value wins
  SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? gitHead(),
};

const server = Bun.serve<WsData, undefined>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const region = url.searchParams.get("region") ?? "global";
      if (srv.upgrade(req, { data: { region } })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    // SR-SEC-09: overwrite any client-supplied x-real-ip with the socket address (mirrors servers/node)
    const fwd = new Request(req, { headers: new Headers(req.headers) });
    fwd.headers.set("x-real-ip", srv.requestIP(req)?.address ?? "unknown");
    return handle(fwd, env, { waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });
  },
  websocket: {
    open(ws) {
      rooms.join(ws);
    },
    message(ws, msg) {
      rooms.onMessage(ws, msg);
    },
    close(ws) {
      rooms.leave(ws);
    },
  },
});
console.log(`aprscaching bun-gateway listening on :${server.port}  (db: ${DB_PATH})`);

// nightly TTL of firehose positions (logger positions kept longer for verification).
// SR-RT-02: run once at startup too — a box that reboots more often than daily never prunes otherwise.
const runTtl = () => void runScheduled(env).catch((e) => console.error("scheduled:", e));
runTtl();
setInterval(runTtl, 24 * 3600 * 1000);

// pull from federation peers on an interval (default 5 min; only if peers are configured)
const FED_SYNC_MS = Number(process.env.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
if (env.FED_PEERS && FED_SYNC_MS > 0) {
  setInterval(() => void syncAllPeers(env).catch((e) => console.error("federation sync:", e)), FED_SYNC_MS);
}

// ---- SR-RT-11: 24/7 process resilience (mirrors servers/node) ----
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing gateway`);
  try {
    server.stop();
  } catch (e) {
    console.error("server stop:", e);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
