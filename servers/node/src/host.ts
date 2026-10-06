// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The host glue both self-host runtimes (this Node server and servers/bun, which imports it) wrap
 * around the runtime-neutral gateway: the live-room binding, the outbound fetch guards, the running
 * commit, and the scheduled jobs.
 */
import { execSync } from "node:child_process";
import { runRelayTick, runScheduled } from "@aprscaching/gateway/app";
import { onPushSoon } from "@aprscaching/gateway/fedpush";
import { catchUp } from "@aprscaching/gateway/fedcatchup";
import { operatorOrigins } from "@aprscaching/gateway/fetchguard";
import { lanOriginAllowed, recordLanSighting } from "@aprscaching/gateway/feddiscover";
import { ownKeyFingerprint } from "@aprscaching/gateway/federation";
import { applyDerivedDefaults, type Env } from "@aprscaching/gateway/env";
import type { LiveEnvelope } from "@aprscaching/gateway/live";
import type { RoomNamespace } from "@aprscaching/gateway/runtime";
import { serveRoom, type RoomsCore } from "@aprscaching/gateway/rooms-core";
import { makeFetchGuard } from "./fetchguard.js";
import { mdnsMode, startMdns } from "./mdns.js";

/**
 * The largest request body either server accepts. Both buffer a body before routing and authentication, so
 * without a ceiling one multi-GB anonymous POST exhausts a Pi's memory; 20 MB clears every legitimate payload
 * (the largest is a cache-media upload). Past it the request is answered 413.
 */
export const BODY_MAX_BYTES = 20 * 1024 * 1024;

/** The `ROOMS` binding: /ingest's live dispatch lands in the in-memory rooms; the WS upgrade is the server's. */
export function roomNamespace(rooms: RoomsCore): RoomNamespace {
  return {
    get: (region) => ({
      fetch: (req: Request) => serveRoom(req, (envelopes) => rooms.dispatch(region, envelopes as LiveEnvelope[])),
    }),
  };
}

/**
 * Outbound fetches never reach this host's private networks. Federation fetches make exceptions for the
 * peers the operator configured by hand (FED_PEERS, FED_HUB_URL), an instance mDNS found at the address
 * that announced it, and everything with FED_ALLOW_PRIVATE=1. Tool-registry fetches, whose addresses
 * players type in, make none.
 */
export function guardOutboundFetches(env: Env): void {
  env.FED_FETCH_GUARD = makeFetchGuard({
    allowedOrigins: operatorOrigins(env),
    allowPrivate: env.FED_ALLOW_PRIVATE === "1",
    allowLocalOrigin: (origin) => lanOriginAllowed(env, origin),
  });
  env.TOOL_FETCH_GUARD = makeFetchGuard();
}

/**
 * Field discovery (FED_MDNS): listen for other instances on the local network and, in `announce` mode, announce
 * this one, which needs its instance id and a signing key. `fieldShape` is a Pocket or Desktop instance, which
 * listens unless the setting says otherwise; the effective mode is written back to the env for Instance admin.
 */
export async function startFieldDiscovery(env: Env, port: number, fieldShape: boolean): Promise<void> {
  const mode = mdnsMode(env.FED_MDNS, fieldShape);
  env.FED_MDNS = mode;
  if (mode === "off") return;
  applyDerivedDefaults(env); // INSTANCE from APP_URL
  const fingerprint = await ownKeyFingerprint(env);
  const self = env.INSTANCE && fingerprint ? { instance: env.INSTANCE, fingerprint, port } : null;
  if (mode === "announce" && !self)
    console.warn("mdns: announcing needs INSTANCE (or APP_URL) and FED_PRIVATE_KEY; listening only");
  try {
    startMdns({
      mode,
      self,
      onFound: (f) => void recordLanSighting(env, f).catch((e) => console.error("mdns:", (e as Error).message)),
    });
  } catch (e) {
    console.warn("mdns: not started: %s", (e as Error).message);
  }
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
 * is idempotent. The frequent federation tasks (pull from peers, push to a hub, retry corroborations,
 * answer relay queries; runFrequentSync) run every `fedSyncMs` (0 disables them) whatever the
 * configuration says: a peer the sysop adds in Instance admin exists only as a row, and a tick without
 * peers, hub or retries costs a few queries, since each task no-ops without its config or rows. The relay
 * tick (a spoke collecting its hub's queries, an asker reading relayed corroboration answers;
 * runRelayTick) runs every `relayPollMs` (0 leaves it to the frequent sync), and a push after a local write
 * reports to the same catch-up loop as the scheduled push.
 */
export function startSchedules(env: Env, fedSyncMs: number, relayPollMs = 0): void {
  const nightly = () => void runScheduled(env).catch((e) => console.error("scheduled:", e));
  nightly();
  setInterval(nightly, 24 * 3600 * 1000);
  if (fedSyncMs > 0) {
    // between intervals: probe an unreachable hub and catch up the moment it answers, and run again soon
    // while a backlog remains (fedcatchup.ts)
    const loop = catchUp(env);
    const frequent = () => void loop.run().catch((e) => console.error("federation sync:", e));
    frequent();
    setInterval(frequent, fedSyncMs);
    onPushSoon((push) => loop.after({ push }));
  }
  if (relayPollMs > 0) setInterval(() => void runRelayTick(env).catch((e) => console.error("relay:", e)), relayPollMs);
}

/** FED_SYNC_INTERVAL_MS: the frequent federation cadence (default 5 min; 0 disables it). */
export const fedSyncInterval = (src: Record<string, string | undefined>): number =>
  Number(src.FED_SYNC_INTERVAL_MS ?? 5 * 60 * 1000);

/** FED_RELAY_POLL_MS: the relay tick's cadence (default 15 s; 0 leaves it to the frequent sync). */
export const relayPollInterval = (src: Record<string, string | undefined>): number =>
  Number(src.FED_RELAY_POLL_MS ?? 15 * 1000);

/** One stray rejection must not kill an unattended gateway (there is no supervisor by default). */
export function logStrayErrors(): void {
  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
  process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
}
