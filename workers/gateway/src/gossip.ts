// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gossip.ts — gossip ping (push-to-pull). A tiny notify that turns the 5-minute poll into
 * near-real-time mirroring without any new always-on connection (stays inside the cost rules).
 *
 *   POST /federation/notify {instance}   "I (instance) have new records — come pull from me."
 *
 * Receiver: the endpoint is unauthenticated, so it can only ever ask for a pull this instance would
 * make anyway. An instance it doesn't follow is ignored before anything else happens; a host and an
 * instance are each rate-limited; and the pull runs through the same coalescer as the scheduled sync,
 * so a burst of notifies never stacks concurrent pulls. The pull itself is signature-verified — the
 * security boundary stays the signed feed, not the ping. Emitter: after a federated write, ping our
 * known peers once per cooldown (a burst of writes coalesces into one round). Both directions share
 * one bounded cooldown map.
 */
import { fedFetch, trimTrailingSlashes } from "./fetchguard.js";
import type { Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { json } from "./app.js";
import { listEnabledPeers, syncPeerByInstance } from "./federation_sync.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";

const COOLDOWN_MS = 2000;
const COOLDOWN_MAX_ENTRIES = 1024;
const lastRun = new Map<string, number>(); // "push:<instance>" | "pull:<instance>" -> last-acted ms
/** Notifies one host may send per minute, and pulls one instance's notifies may trigger per minute. */
const NOTIFY_PER_HOST = 120;
const NOTIFY_PER_INSTANCE = 30;

/** Pure (injectable map/clock for tests): has `key` cooled down enough to act again? Stamps on yes. */
export function gossipDue(
  key: string,
  nowMs: number,
  lastMap: Map<string, number> = lastRun,
  cooldownMs = COOLDOWN_MS,
): boolean {
  const prev = lastMap.get(key);
  if (prev != null && nowMs - prev < cooldownMs) return false;
  lastMap.delete(key); // re-insert so the map's order is least recently acted first
  lastMap.set(key, nowMs);
  // bounded: drop the least recently acted keys once the map is full
  while (lastMap.size > COOLDOWN_MAX_ENTRIES) lastMap.delete(lastMap.keys().next().value as string);
  return true;
}

/** Which write routes create/change federated records → worth a gossip ping. */
export function isFederatedWrite(method: string, p: string): boolean {
  if (method !== "POST") return false;
  return (
    p === "/api/caches" || // new cache
    /^\/api\/caches\/\d+\/logs$/.test(p) || // new find
    /^\/api\/admin\/adoptions\/(\d+\/assign|requests\/\d+\/approve)$/.test(p) || // a cache changes owner
    p === "/keys/register" || // new callsign key
    /^\/api\/account\/[A-Za-z0-9-]+\/delete$/.test(p)
  ); // tombstones (delete propagation)
}

/** Receiver: a peer says "come pull." Coalesce, then trigger an incremental sync off the response path. */
export async function handleFederationNotify(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const nowMs = Date.now();
  if (await rateLimitedDurable(env, `notify-ip:${clientIp(req, env)}`, nowMs, NOTIFY_PER_HOST))
    return json({ ok: false, error: "rate limited" }, { status: 429 });
  const b = (await req.json().catch(() => null)) as { instance?: string } | null;
  const instance = typeof b?.instance === "string" ? b.instance.trim().toLowerCase() : "";
  if (!instance) return json({ ok: false, error: "instance required" }, { status: 400 });
  if (instance === env.INSTANCE) return json({ ok: true, ignored: "self" });
  const followed = await env.DB.prepare(
    "SELECT 1 AS x FROM fed_peers WHERE instance = ? AND enabled = 1 AND trust != 'blocked'",
  )
    .bind(instance)
    .first();
  if (!followed) return json({ ok: true, ignored: "unknown" });
  if (await rateLimitedDurable(env, `notify:${instance}`, nowMs, NOTIFY_PER_INSTANCE))
    return json({ ok: true, coalesced: true });
  if (!gossipDue(`pull:${instance}`, nowMs)) return json({ ok: true, coalesced: true });
  ctx.waitUntil(syncPeerByInstance(env, instance).catch(() => {}));
  return json({ ok: true, syncing: instance }, { status: 202 });
}

/** Emitter: tell known peers to come pull from us. Coalesced + best-effort; run via ctx.waitUntil. */
export async function notifyPeers(env: Env): Promise<void> {
  if (!env.INSTANCE) return;
  if (!gossipDue(`push:${env.INSTANCE}`, Date.now())) return; // coalesce a burst of writes into one round
  const peers = await listEnabledPeers(env);
  await Promise.all(
    peers.map(async (p) => {
      const base = trimTrailingSlashes(p.url);
      try {
        await fedFetch(env, `${base}/federation/notify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instance: env.INSTANCE }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        /* best-effort; the 5-min poll is the backstop */
      }
    }),
  );
}
