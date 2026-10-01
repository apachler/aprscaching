// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The host glue both self-host runtimes (this Node server and servers/bun, which imports it) wrap
 * around the runtime-neutral gateway: the live-room binding, the federation fetch guard, the running
 * commit, and the scheduled jobs.
 */
import { execSync } from "node:child_process";
import { runScheduled } from "@aprscaching/gateway/app";
import { catchUp } from "@aprscaching/gateway/fedcatchup";
import { operatorOrigins } from "@aprscaching/gateway/fetchguard";
import type { Env } from "@aprscaching/gateway/env";
import type { LiveEnvelope } from "@aprscaching/gateway/live";
import { serveRoom } from "@aprscaching/gateway/budget";
import type { RoomNamespace } from "@aprscaching/gateway/runtime";
import type { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { makeFetchGuard } from "./fetchguard.js";

/**
 * The `ROOMS` binding: /ingest's live dispatch and the write budget land in the in-memory rooms, with the
 * Durable Object's endpoints (budget.ts serveRoom); the WS upgrade is the server's.
 */
export function roomNamespace(rooms: RoomsCore): RoomNamespace {
  return {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: (req: Request) =>
        serveRoom(
          req,
          (envelopes) => rooms.dispatch(String(id), envelopes as LiveEnvelope[]),
          () => rooms.budgetCounter,
        ),
    }),
  };
}

/**
 * Federation fetches never reach this host's private networks, except the peers the operator
 * configured by hand (FED_PEERS, FED_HUB_URL) or with FED_ALLOW_PRIVATE=1.
 */
export function guardFederationFetches(env: Env): void {
  env.FED_FETCH_GUARD = makeFetchGuard({
    allowedOrigins: operatorOrigins(env),
    allowPrivate: env.FED_ALLOW_PRIVATE === "1",
  });
}

/** The checked-out commit, for the AGPL §13 source link of an instance run from a git checkout. */
export function gitHead(): string | undefined {
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

/**
 * The scheduled jobs. The nightly job (TTL pruning, digests) runs once at start too — a box that
 * reboots or closes more often than daily would otherwise never prune, so its database only grows; it
 * is idempotent. The frequent federation tasks (pull from peers, push to a hub, answer relay queries —
 * the set the Worker's 15-minute cron runs) run every `fedSyncMs` (0 disables them) when peers or a hub
 * are configured; each no-ops unless its config is present.
 */
export function startSchedules(env: Env, fedSyncMs: number): void {
  const nightly = () => void runScheduled(env).catch((e) => console.error("scheduled:", e));
  nightly();
  setInterval(nightly, 24 * 3600 * 1000);
  if ((env.FED_PEERS || env.FED_HUB_URL) && fedSyncMs > 0) {
    // between intervals: probe an unreachable hub and catch up the moment it answers, and run again soon
    // while a backlog remains (fedcatchup.ts)
    const loop = catchUp(env);
    const frequent = () => void loop.run().catch((e) => console.error("federation sync:", e));
    frequent();
    setInterval(frequent, fedSyncMs);
  }
}

/** FED_SYNC_INTERVAL_MS: the frequent federation cadence (default 5 min; 0 disables it). */
export const fedSyncInterval = (src: Record<string, string | undefined>): number =>
  Number(src.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);

/** One stray rejection must not kill an unattended gateway (there is no supervisor by default). */
export function logStrayErrors(): void {
  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
  process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
}
