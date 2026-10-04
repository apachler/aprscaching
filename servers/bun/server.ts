#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * aprscaching bun-gateway — the Bun-runtime self-host core, and the server the desktop single binary
 * wraps (deploy/desktop/launcher.ts).
 *
 * Same handlers as the Node server (imported from @aprscaching/gateway/app),
 * wired to: bun:sqlite via the database shim (./d1.ts) · the shared in-memory region rooms over
 * Bun.serve WebSockets (./rooms.ts) · the Node server's filesystem MediaStore, secrets, fetch guard,
 * migration reader and schedules (node:fs and friends work under Bun). Bun.serve speaks Web
 * Request/Response natively, so handle() is called directly with no http bridge.
 *
 * Run: `bun run servers/bun/server.ts`  (env: PORT, DB_PATH, MIGRATIONS_DIR, MEDIA_DIR, INGEST_SECRET, OPERATOR_SECRET, …)
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handle, isGatewayPath } from "@aprscaching/gateway/app";
import { federationConfigError } from "@aprscaching/gateway/federation";
import { stampClientIp } from "@aprscaching/gateway/corroborate_privacy";
import { stringEnvFrom, type Env } from "@aprscaching/gateway/env";
import { validateConfig } from "@aprscaching/shared";
import { migrate, type Migration } from "@aprscaching/gateway/migrate";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { liveRegionOf } from "@aprscaching/gateway/live";
import { BunDb } from "./d1.ts";
import { roomHandlers, type WsData } from "./rooms.ts";
import { makeFsMedia } from "../node/src/media.ts";
import { fileTiles } from "../node/src/tiles.ts";
import { migrationsFromDir } from "../node/src/migrate.ts";
import { resolveServerSecrets, type ServerSecrets } from "../node/src/secrets.ts";
import {
  fedSyncInterval,
  gitHead,
  guardFederationFetches,
  logStrayErrors,
  roomNamespace,
  startSchedules,
} from "../node/src/host.ts";

export interface BunServerOptions {
  /** The process environment the settings are read from. */
  environment: Record<string, string | undefined>;
  port: number;
  /** The address to listen on (all interfaces when unset). */
  hostname?: string;
  dbPath: string;
  mediaDir: string;
  migrations: Migration[];
  /** The resolved ingest, operator and session secrets. */
  secrets: ServerSecrets;
  /** The running commit or tag, for the AGPL §13 source link. */
  sourceCommit?: string;
  /** Serves every request no gateway route claims — the desktop app's embedded SPA. */
  spa?: (pathname: string) => Response;
}

export interface BunServer {
  server: ReturnType<typeof Bun.serve>;
  env: Env;
  db: BunDb;
  /** Migrations applied at start. */
  migrated: string[];
}

/**
 * Start the gateway on Bun: migrate the database, build the runtime-neutral env, serve HTTP and the
 * live WebSocket rooms, start the scheduled jobs, and stop cleanly (WAL checkpointed) on SIGINT/SIGTERM.
 * Refuses a malformed setting and a federation registry whose authority key is not pinned, as the Node
 * server does.
 */
export function createServer(opts: BunServerOptions): BunServer {
  const configProblems = validateConfig(opts.environment, ["gateway", "server"]);
  if (configProblems.length) throw new Error(configProblems.map((p) => p.message).join("; "));
  const fedConfigError = federationConfigError(opts.environment as unknown as Env);
  if (fedConfigError) throw new Error(fedConfigError);

  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new BunDb(opts.dbPath);
  const migrated = migrate(
    { exec: (sql) => db.raw.exec(sql), query: (sql, ...params) => db.raw.query(sql).all(...params) },
    opts.migrations,
  );

  const rooms = new RoomsCore();
  const env: Env = {
    DB: db,
    TILES: fileTiles(opts.environment.OFFLINE_TILES_PATH),
    MEDIA: makeFsMedia(opts.mediaDir),
    ROOMS: roomNamespace(rooms),
    ...stringEnvFrom(opts.environment), // forward EVERY config key so keys like ADMIN_CALLSIGNS reach the gateway
    ...opts.secrets,
    SOURCE_COMMIT: opts.environment.SOURCE_COMMIT ?? opts.sourceCommit,
  };
  guardFederationFetches(env);

  const server = Bun.serve<WsData, undefined>({
    hostname: opts.hostname,
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const region = liveRegionOf(url);
        if (!region) return new Response("unknown region", { status: 400 });
        if (srv.upgrade(req, { data: { region } })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (opts.spa && !isGatewayPath(url.pathname)) return opts.spa(url.pathname);
      // the socket address is the client identity for rate limits: overwrite any client-supplied
      // x-real-ip and drop a client-sent cf-connecting-ip unless a Cloudflare edge is declared
      const headers = new Headers(req.headers);
      stampClientIp(headers, srv.requestIP(req)?.address, env);
      return handle(new Request(req, { headers }), env, { waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });
    },
    websocket: roomHandlers(rooms),
  });

  startSchedules(env, fedSyncInterval(opts.environment));

  // 24/7 resilience: log stray errors; a stop signal closes the listener and checkpoints SQLite (WAL)
  // so a service stop or a window-manager quit is never data-lossy.
  logStrayErrors();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received — closing gateway`);
    try {
      server.stop();
      db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      console.error("stop:", e);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  return { server, env, db, migrated };
}

if (import.meta.main) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const DB_PATH = process.env.DB_PATH ?? join(HERE, "data/aprscaching.db");
  const secrets = resolveServerSecrets(process.env, dirname(DB_PATH));
  if (!secrets.ok) {
    console.error(`FATAL: ${secrets.error}`);
    process.exit(1);
  }
  if (secrets.sessionSource === "generated") console.log(`SESSION_SECRET generated and kept in ${dirname(DB_PATH)}`);
  let started: BunServer;
  try {
    started = createServer({
      environment: process.env,
      port: Number(process.env.PORT) || 8787, // a blank/NaN PORT must not bind port 0
      dbPath: DB_PATH,
      mediaDir: process.env.MEDIA_DIR ?? join(HERE, "data/media"),
      migrations: migrationsFromDir(process.env.MIGRATIONS_DIR ?? join(HERE, "../../db/migrations")),
      secrets: secrets.secrets,
      sourceCommit: gitHead(),
    });
  } catch (e) {
    console.error(`FATAL: ${(e as Error).message}`);
    process.exit(1);
  }
  const { migrated, server } = started;
  console.log(migrated.length ? `migrations applied: ${migrated.join(", ")}` : "migrations up to date");
  console.log(`aprscaching bun-gateway listening on :${server.port}  (db: ${DB_PATH})`);
}
