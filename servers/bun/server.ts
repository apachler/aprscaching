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
import type { Env } from "@aprsweb/gateway/env";
import type { LiveEnvelope } from "@aprsweb/gateway/live";
import { BunDb } from "./d1.ts";
import { migrate } from "./migrate.ts";
import { makeFsMedia } from "./media.ts";
import { BunRooms, type WsData } from "./rooms.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? join(HERE, "data/aprscaching.db");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(HERE, "../../db/migrations");
const MEDIA_DIR = process.env.MEDIA_DIR ?? join(HERE, "data/media");
const INGEST_SECRET = process.env.INGEST_SECRET ?? "change-me";
function gitHead(): string | undefined {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined; }
  catch { return undefined; }
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
  INSTANCE: process.env.INSTANCE,
  FED_PRIVATE_KEY: process.env.FED_PRIVATE_KEY,
  FED_KEY_HISTORY: process.env.FED_KEY_HISTORY,
  FED_ROTATIONS: process.env.FED_ROTATIONS,
  FED_REGISTRY: process.env.FED_REGISTRY,
  FED_REGISTRY_KEY: process.env.FED_REGISTRY_KEY,
  FED_OPERATOR: process.env.FED_OPERATOR,
  FED_APRS_CALL: process.env.FED_APRS_CALL,
  FED_PEERS: process.env.FED_PEERS,
  FED_DISCOVER: process.env.FED_DISCOVER,
  FED_CORROBORATION_QUORUM: process.env.FED_CORROBORATION_QUORUM,
  FED_AUTO_PROMOTE: process.env.FED_AUTO_PROMOTE,
  TOMBSTONE_TTL_DAYS: process.env.TOMBSTONE_TTL_DAYS,
  FED_CORROBORATION_SECRET: process.env.FED_CORROBORATION_SECRET,
  FED_REVEAL_IGATE: process.env.FED_REVEAL_IGATE,
  FED_CORROBORATION_GRID_DEG: process.env.FED_CORROBORATION_GRID_DEG,
  FED_CORROBORATION_TIME_BUCKET_SEC: process.env.FED_CORROBORATION_TIME_BUCKET_SEC,
  FED_CORROBORATION_DIST_BUCKET_M: process.env.FED_CORROBORATION_DIST_BUCKET_M,
  FED_SUBMIT_SECRET: process.env.FED_SUBMIT_SECRET,
  FED_SUBMIT_INSTANCES: process.env.FED_SUBMIT_INSTANCES,
  FED_HUB_URL: process.env.FED_HUB_URL,
  FED_RELAY_SECRET: process.env.FED_RELAY_SECRET,
  OKAPI_BASE: process.env.OKAPI_BASE,
  OKAPI_KEY: process.env.OKAPI_KEY,
  BBS_CALL: process.env.BBS_CALL,
  // AGPL §13 source (ADR-3): commit from env, else git (self-host-from-source)
  SOURCE_REPO: process.env.SOURCE_REPO,
  SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? gitHead(),
  SOURCE_TAG: process.env.SOURCE_TAG,
  SOURCE_BUILT_AT: process.env.SOURCE_BUILT_AT,
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
    return handle(req, env, { waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });
  },
  websocket: {
    open(ws) { rooms.join(ws); },
    message(ws, msg) { rooms.onMessage(ws, msg); },
    close(ws) { rooms.leave(ws); },
  },
});
console.log(`aprscaching bun-gateway listening on :${server.port}  (db: ${DB_PATH})`);

// nightly TTL of firehose positions (logger positions kept longer for verification)
setInterval(() => void runScheduled(env).catch((e) => console.error("scheduled:", e)), 24 * 3600 * 1000);

// pull from federation peers on an interval (default 5 min; only if peers are configured)
const FED_SYNC_MS = Number(process.env.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
if (env.FED_PEERS && FED_SYNC_MS > 0) {
  setInterval(() => void syncAllPeers(env).catch((e) => console.error("federation sync:", e)), FED_SYNC_MS);
}
