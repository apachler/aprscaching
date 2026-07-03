// SPDX-License-Identifier: AGPL-3.0-or-later
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
import {
  coarsenConfig,
  snapToGrid,
  gridSlackM,
  bucketWindow,
  distanceBucketM,
  bucketTs,
  corroborationAuthorized,
  clientIp,
  rateLimited,
  negCached,
  negStore,
} from "./corroborate_privacy.js";

/** Cap the peers probed per find — a bounded fan-out budget (T1.2 hardening). */
const CORROBORATION_FANOUT = 16;

export interface Evidence {
  instance: string;
  igateCall?: string;
  distanceM: number;
  ts: number;
  corroborators?: number;
}
export interface CorroborationQuery {
  callsign: string;
  lat: number;
  lon: number;
  radiusM: number;
  since: number;
  until: number;
}

/** Base callsign without SSID, for the independence check (IGate must not be the logger). */
function baseCall(c: string): string {
  return c.split("-")[0]!.toUpperCase();
}

/**
 * Which IGate (if any) to credit for a Tier-A find. For a locally
 * verified find it's the gating IGate of the matched RF position; for a peer-corroborated find it's
 * the peer's revealed IGate (only present when both peers opt into FED_REVEAL_IGATE) — that's the
 * cross-instance credit. Never the logger's own call (no self-credit). Pure / testable.
 */
export function corroboratorIgate(opts: {
  method: string;
  matchedIgate?: string | null;
  peerIgate?: string | null;
  loggerCall: string;
}): string | null {
  const ig = (opts.method === "aprs_rf_peer" ? opts.peerIgate : opts.matchedIgate) ?? null;
  if (!ig) return null;
  return baseCall(ig) === baseCall(opts.loggerCall) ? null : ig.toUpperCase();
}

/** Search THIS instance's RF positions for an independent corroboration. Returns evidence or null. */
async function localCorroboration(
  env: Env,
  q: CorroborationQuery,
  excludeIgates: Set<string>,
): Promise<Omit<Evidence, "instance"> | null> {
  const radius = Math.min(q.radiusM || DEFAULT_POLICY.radiusM, 1000);
  const callBase = baseCall(q.callsign);
  const rows = (
    await env.DB.prepare(
      `SELECT lat, lon, ts, igate_call FROM positions
      WHERE callsign = ? AND heard_via = 'rf' AND source != 'service' AND ts BETWEEN ? AND ?
      ORDER BY ts DESC LIMIT 500`,
    )
      .bind(q.callsign.toUpperCase(), q.since, q.until)
      .all<{ lat: number; lon: number; ts: number; igate_call: string | null }>()
  ).results;

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

/** A stable key for rate-limit / negative memoization: callsign + the coarsened cell + time bucket. */
function probeKey(b: CorroborationQuery, cfg: ReturnType<typeof coarsenConfig>): string {
  const c = snapToGrid(b.lat, b.lon, cfg.gridDeg);
  const w = bucketWindow(b.since, b.until, cfg.timeBucketSec);
  return `${baseCall(b.callsign)}|${c.lat}|${c.lon}|${w.since}|${w.until}`;
}

/**
 * Endpoint: a peer asks us to corroborate a find. Yes/no + **coarse** evidence (T1.2). The response is
 * coarsened unconditionally — a distance bucket + bucketed ts + this instance, never the exact IGate
 * (unless FED_REVEAL_IGATE) — so even a prober sending exact coordinates can't use this as a precise
 * location oracle. Gated by an optional shared secret, in-memory rate limits, and negative memoization.
 */
export async function handleCorroborate(req: Request, env: Env): Promise<Response> {
  if (!corroborationAuthorized(env, req)) return json({ corroborated: false, error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as (CorroborationQuery & { excludeIgates?: string[] }) | null;
  if (!b || !b.callsign || b.lat == null || b.lon == null || b.since == null || b.until == null)
    return json({ corroborated: false, error: "bad query" }, { status: 400 });

  const cfg = coarsenConfig(env);
  const nowMs = Date.now();
  if (rateLimited(`ip:${clientIp(req)}`, nowMs) || rateLimited(`call:${baseCall(b.callsign)}`, nowMs))
    return json({ corroborated: false, error: "rate limited" }, { status: 429 });

  const key = probeKey(b, cfg);
  if (negCached(key, nowMs)) return json({ corroborated: false, cached: true });

  const exclude = new Set((b.excludeIgates ?? []).map(baseCall));
  const ev = await localCorroboration(env, b, exclude);
  if (!ev) {
    negStore(key, nowMs);
    return json({ corroborated: false });
  }

  const evidence: { distanceM: number; ts: number; igateCall?: string } = {
    distanceM: distanceBucketM(ev.distanceM, cfg.distBucketM),
    ts: bucketTs(ev.ts, cfg.timeBucketSec),
  };
  if (env.FED_REVEAL_IGATE && ev.igateCall) evidence.igateCall = ev.igateCall; // both-opt-in only
  return json({ corroborated: true, evidence });
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
/** Auto-promotion rule (pure, testable — T1.1): an unvetted peer that has earned enough confirmed
 *  corroborations (and no contradictions) crosses into `trusted`. threshold ≤ 0 disables it. */
export function shouldAutoPromote(trust: string, repConfirmed: number, repFailed: number, threshold: number): boolean {
  return threshold > 0 && trust === "unvetted" && repFailed === 0 && repConfirmed >= threshold;
}

/** Reward the peers whose corroboration was independently confirmed (the find reached Tier A): bump
 *  rep_confirmed, and auto-promote any unvetted peer that crosses the threshold (T1.1). */
async function creditCorroboration(env: Env, urls: string[], threshold: number): Promise<void> {
  const at = Math.floor(Date.now() / 1000);
  for (const url of new Set(urls)) {
    await env.DB.prepare("UPDATE fed_peers SET rep_confirmed = rep_confirmed + 1 WHERE url = ?").bind(url).run();
    if (threshold > 0)
      await env.DB.prepare(
        "UPDATE fed_peers SET trust='trusted', added_via='auto-promoted', approved_at=COALESCE(approved_at,?) WHERE url=? AND trust='unvetted' AND rep_failed=0 AND rep_confirmed >= ?",
      )
        .bind(at, url, threshold)
        .run();
  }
}

/**
 * The contradiction signal (T1.1, was deferred): which probed peers DENIED a corroboration the trusted
 * quorum nonetheless confirmed. A peer that answered the same (coarsened) query with `corroborated:false`
 * while the network reached Tier A is contradicting a confirmed result — a negative reputation signal.
 * Unavailable peers (timeout / error) are NOT contradictions, only explicit deniers. Pure + testable.
 */
export function contradictors(probes: { url: string; denied: boolean }[], hasWinner: boolean): string[] {
  if (!hasWinner) return []; // nothing was confirmed → a "no" isn't a contradiction
  return [...new Set(probes.filter((p) => p.denied).map((p) => p.url))];
}

/** Penalise peers that contradicted a confirmed corroboration: bump rep_failed (blocks auto-promotion). */
async function debitContradiction(env: Env, urls: string[]): Promise<void> {
  for (const url of new Set(urls)) {
    await env.DB.prepare("UPDATE fed_peers SET rep_failed = rep_failed + 1 WHERE url = ?").bind(url).run();
  }
}

export async function queryPeerCorroboration(env: Env, q: CorroborationQuery): Promise<Evidence | null> {
  const quorum = Number(env.FED_CORROBORATION_QUORUM ?? 1);
  const threshold = Number(env.FED_AUTO_PROMOTE ?? 0);
  // trusted peers count toward Tier A; when reputation/promotion is enabled, unvetted peers are also
  // probed but ONLY advisorily — their hits never reach quorum, they just let an unvetted peer EARN
  // trust by agreeing with confirmed corroborations (T1.1). Default (threshold 0) = trusted-only.
  const pool = (await listEnabledPeers(env))
    .filter((p) => !(p.instance && p.instance === env.INSTANCE))
    .filter((p) => p.trust === "trusted" || (threshold > 0 && p.trust === "unvetted"))
    .slice(0, CORROBORATION_FANOUT); // bounded fan-out budget

  // good-citizen request coarsening: snap the center to a grid cell, widen the radius to cover the
  // snap, bucket the time window — peers never see our exact lat/lon/second (T1.2 privacy).
  const cfg = coarsenConfig(env);
  const c = snapToGrid(q.lat, q.lon, cfg.gridDeg);
  const w = bucketWindow(q.since, q.until, cfg.timeBucketSec);
  const cq: CorroborationQuery = {
    ...q,
    lat: c.lat,
    lon: c.lon,
    radiusM: (q.radiusM || DEFAULT_POLICY.radiusM) + gridSlackM(cfg.gridDeg),
    since: w.since,
    until: w.until,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.FED_CORROBORATION_SECRET) headers["x-fed-secret"] = env.FED_CORROBORATION_SECRET;

  const probes = await Promise.all(
    pool.map(async (peer): Promise<{ peer: (typeof pool)[number]; ev: Evidence | null; denied: boolean }> => {
      const base = peer.url.replace(/\/+$/, "");
      try {
        const r = await fetch(`${base}/federation/corroborate`, {
          method: "POST",
          headers,
          body: JSON.stringify(cq),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) return { peer, ev: null, denied: false }; // unavailable ≠ contradiction
        const data = (await r.json()) as { corroborated: boolean; evidence?: Omit<Evidence, "instance"> };
        const ev = data.corroborated && data.evidence ? { instance: peer.instance ?? base, ...data.evidence } : null;
        return { peer, ev, denied: data.corroborated === false }; // explicit "no" from a reachable peer
      } catch {
        return { peer, ev: null, denied: false };
      }
    }),
  );

  // Tier A is decided from TRUSTED hits only (quorum unchanged); unvetted hits are advisory.
  const trustedHits = probes.filter((x) => x.ev && x.peer.trust === "trusted").map((x) => x.ev as Evidence);
  const winner = selectCorroboration(trustedHits, quorum);
  if (winner) {
    await creditCorroboration(
      env,
      probes.filter((x) => x.ev).map((x) => x.peer.url),
      threshold,
    );
    // T1.1 contradiction signal: peers that DENIED a corroboration the trusted quorum confirmed lose rep.
    await debitContradiction(
      env,
      contradictors(
        probes.map((x) => ({ url: x.peer.url, denied: x.denied })),
        true,
      ),
    );
  }
  return winner;
}
