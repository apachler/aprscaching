// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gossip.ts — F5/T2.1: gossip ping (push-to-pull). A tiny notify that turns the 5-minute poll into
 * near-real-time mirroring without any new always-on connection (stays inside the cost rules).
 *
 *   POST /federation/notify {instance}   "I (instance) have new records — come pull from me."
 *
 * Receiver: debounced + coalesced, it triggers an incremental `syncPeer` of that origin (only if it's
 * a peer we already follow and isn't blocked). The pull itself is signature-verified, so a forged
 * notify can at most cause a (rate-limited) pull from an already-trusted peer — the security boundary
 * stays the signed feed, not the ping. Emitter: after a federated write, ping our known peers once per
 * cooldown (a burst of writes coalesces into one round). Both directions share one cooldown map.
 */
import type { Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { json } from "./app.js";
import { listEnabledPeers, syncPeerByInstance } from "./federation_sync.js";

const COOLDOWN_MS = 2000;
const lastRun = new Map<string, number>(); // "push:<instance>" | "pull:<instance>" -> last-acted ms

/** Pure (injectable map/clock for tests): has `key` cooled down enough to act again? Stamps on yes. */
export function gossipDue(key: string, nowMs: number, lastMap: Map<string, number> = lastRun, cooldownMs = COOLDOWN_MS): boolean {
  const prev = lastMap.get(key);
  if (prev != null && nowMs - prev < cooldownMs) return false;
  lastMap.set(key, nowMs);
  return true;
}

/** Which write routes create/change federated records → worth a gossip ping. */
export function isFederatedWrite(method: string, p: string): boolean {
  if (method !== "POST") return false;
  return p === "/api/caches"                                  // new cache
    || /^\/api\/caches\/\d+\/logs$/.test(p)                   // new find
    || p === "/keys/register"                                 // new callsign key
    || /^\/api\/account\/[A-Za-z0-9-]+\/delete$/.test(p);     // tombstones (delete propagation)
}

/** Receiver: a peer says "come pull." Coalesce, then trigger an incremental sync off the response path. */
export async function handleFederationNotify(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { instance?: string } | null;
  const instance = b?.instance?.trim();
  if (!instance) return json({ ok: false, error: "instance required" }, { status: 400 });
  if (instance === env.INSTANCE) return json({ ok: true, ignored: "self" });
  if (!gossipDue(`pull:${instance}`, Date.now())) return json({ ok: true, coalesced: true });
  ctx.waitUntil(syncPeerByInstance(env, instance).catch(() => {}));
  return json({ ok: true, syncing: instance }, { status: 202 });
}

/** Emitter: tell known peers to come pull from us. Coalesced + best-effort; run via ctx.waitUntil. */
export async function notifyPeers(env: Env): Promise<void> {
  if (!env.INSTANCE) return;
  if (!gossipDue(`push:${env.INSTANCE}`, Date.now())) return; // coalesce a burst of writes into one round
  const peers = await listEnabledPeers(env);
  await Promise.all(peers.map(async (p) => {
    const base = p.url.replace(/\/+$/, "");
    try {
      await fetch(`${base}/federation/notify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance: env.INSTANCE }), signal: AbortSignal.timeout(3000),
      });
    } catch { /* best-effort; the 5-min poll is the backstop */ }
  }));
}
