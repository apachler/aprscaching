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
import Database from "better-sqlite3";
import { WebSocketServer } from "ws";
import { handle, runScheduled, syncAllPeers } from "@aprsweb/gateway/app";
import type { Env } from "@aprsweb/gateway/env";
import { makeD1 } from "./d1.js";
import { migrate } from "./migrate.js";
import { Rooms } from "./rooms.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? path.resolve(HERE, "../data/aprscaching.db");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(HERE, "../../../db/migrations");
const INGEST_SECRET = process.env.INGEST_SECRET ?? "change-me";

// ---- storage ----
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const ran = migrate(sqlite, MIGRATIONS_DIR);
console.log(ran.length ? `migrations applied: ${ran.join(", ")}` : "migrations up to date");

// ---- env (runtime-neutral bindings) ----
const rooms = new Rooms();
const env: Env = {
  DB: makeD1(sqlite),
  TILES: {}, // R2 unused in M1
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
  INSTANCE: process.env.INSTANCE,
  FED_PRIVATE_KEY: process.env.FED_PRIVATE_KEY,
  FED_PEERS: process.env.FED_PEERS,
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
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, { method, headers, body: hasBody ? await readBody(nreq) : undefined });
    // (readBody returns a string; the gateway API is JSON throughout)
    const response = await handle(request, env, { waitUntil: (p) => void p.catch(() => {}) });

    nres.statusCode = response.status;
    response.headers.forEach((value, key) => nres.setHeader(key, value));
    nres.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    nres.statusCode = 500;
    nres.setHeader("content-type", "application/json");
    nres.end(JSON.stringify({ error: (e as Error).message }));
  }
});

// ---- websocket upgrade (region rooms) ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (u.pathname !== "/ws") { socket.destroy(); return; }
  const region = u.searchParams.get("region") ?? "global";
  wss.handleUpgrade(req, socket, head, (ws) => rooms.join(region, ws));
});

server.listen(PORT, () => console.log(`aprscaching node-gateway listening on :${PORT}  (db: ${DB_PATH})`));

// nightly TTL of firehose positions (logger positions kept longer for verification)
setInterval(() => void runScheduled(env).catch((e) => console.error("scheduled:", e)), 24 * 3600 * 1000);

// pull from federation peers on an interval (default 5 min; only if peers are configured)
const FED_SYNC_MS = Number(process.env.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);
if (env.FED_PEERS && FED_SYNC_MS > 0) {
  setInterval(() => void syncAllPeers(env).catch((e) => console.error("federation sync:", e)), FED_SYNC_MS);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
