/**
 * corroborate.ts — F3: cross-instance presence verification (the network effect).
 *
 * RF-heard positions are public (they were broadcast on the air and flow through APRS-IS), so an
 * instance will happily answer a peer's narrow question: "did you independently hear <callsign> on
 * RF within <radius> of <lat,lon> during <window>, gated by an IGate the logger doesn't control?"
 *
 * When a find can't reach Tier A locally (this instance never heard the logger's RF fix), it asks
 * its peers. The more instances and IGates participate, the more finds reach Tier A — exactly the
 * iNaturalist "more observers ⇒ better data" dynamic. Mirrors are display-only; corroboration is
 * the trust-bearing exchange.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { haversineMeters } from "@aprsweb/aprs";
import { DEFAULT_POLICY } from "./verify.js";
import { listEnabledPeers } from "./federation_sync.js";

export interface Evidence { instance: string; igateCall: string; distanceM: number; ts: number; corroborators?: number }
export interface CorroborationQuery {
  callsign: string; lat: number; lon: number; radiusM: number; since: number; until: number;
}

/** Base callsign without SSID, for the independence check (IGate must not be the logger). */
function baseCall(c: string): string { return c.split("-")[0]!.toUpperCase(); }

/** Search THIS instance's RF positions for an independent corroboration. Returns evidence or null. */
async function localCorroboration(
  env: Env, q: CorroborationQuery, excludeIgates: Set<string>,
): Promise<Omit<Evidence, "instance"> | null> {
  const radius = Math.min(q.radiusM || DEFAULT_POLICY.radiusM, 1000);
  const callBase = baseCall(q.callsign);
  const rows = (await env.DB.prepare(
    `SELECT lat, lon, ts, igate_call FROM positions
      WHERE callsign = ? AND heard_via = 'rf' AND source != 'service' AND ts BETWEEN ? AND ?
      ORDER BY ts DESC LIMIT 500`,
  ).bind(q.callsign.toUpperCase(), q.since, q.until)
    .all<{ lat: number; lon: number; ts: number; igate_call: string | null }>()).results;

  for (const r of rows) {
    const ig = r.igate_call ?? "";
    if (!ig) continue;
    const igBase = baseCall(ig);
    if (igBase === callBase || excludeIgates.has(igBase)) continue; // self-gated / excluded
    const d = haversineMeters(r.lat, r.lon, q.lat, q.lon);
    if (d <= radius) return { igateCall: ig, distanceM: d, ts: r.ts };
  }
  return null;
}

/** Endpoint: a peer asks us to corroborate a find. Yes/no + minimal evidence. */
export async function handleCorroborate(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => null)) as (CorroborationQuery & { excludeIgates?: string[] }) | null;
  if (!b || !b.callsign || b.lat == null || b.lon == null || b.since == null || b.until == null)
    return json({ corroborated: false, error: "bad query" }, { status: 400 });
  const exclude = new Set((b.excludeIgates ?? []).map(baseCall));
  const ev = await localCorroboration(env, b, exclude);
  return json(ev ? { corroborated: true, evidence: ev } : { corroborated: false });
}

/**
 * Quorum decision (pure, testable — F4/T1.2): require corroboration from **≥ quorum DISTINCT
 * instances** before a find may reach Tier A. De-dupes by instance (the same instance answering
 * twice is one voice) so no single peer can mint Tier A; below quorum returns null. Returns the
 * closest evidence, annotated with how many independent instances corroborated.
 */
export function selectCorroboration(hits: Evidence[], quorum: number): Evidence | null {
  const need = Math.max(1, Math.floor(quorum) || 1);
  const byInstance = new Map<string, Evidence>();
  for (const h of hits) {
    const prev = byInstance.get(h.instance);
    if (!prev || h.distanceM < prev.distanceM) byInstance.set(h.instance, h); // keep the closest per instance
  }
  if (byInstance.size < need) return null;
  const best = [...byInstance.values()].sort((a, b) => a.distanceM - b.distanceM)[0]!;
  return { ...best, corroborators: byInstance.size };
}

/**
 * Client: ask peers to corroborate **in parallel**, then apply the quorum gate (default 1; raise via
 * `FED_CORROBORATION_QUORUM` as the network grows). Only **`trusted`** peers count toward Tier A (T1.1):
 * `unvetted`/auto-discovered peers are mirrored-but-flagged and never lend verification weight, and
 * `blocked` peers are already filtered out by `listEnabledPeers`. So a stranger a peer auto-discovered
 * can't mint Tier A — only the operator's curated trust set can.
 */
export async function queryPeerCorroboration(env: Env, q: CorroborationQuery): Promise<Evidence | null> {
  const peers = (await listEnabledPeers(env))
    .filter((p) => p.trust === "trusted")
    .filter((p) => !(p.instance && p.instance === env.INSTANCE));
  const quorum = Number(env.FED_CORROBORATION_QUORUM ?? 1);
  const results = await Promise.all(peers.map(async (peer): Promise<Evidence | null> => {
    const base = peer.url.replace(/\/+$/, "");
    try {
      const r = await fetch(`${base}/federation/corroborate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(q),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return null;
      const data = (await r.json()) as { corroborated: boolean; evidence?: Omit<Evidence, "instance"> };
      return data.corroborated && data.evidence ? { instance: peer.instance ?? base, ...data.evidence } : null;
    } catch { return null; }
  }));
  return selectCorroboration(results.filter((e): e is Evidence => e != null), quorum);
}
