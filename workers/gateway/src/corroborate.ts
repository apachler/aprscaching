// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * corroborate.ts — cross-instance presence verification (the network effect).
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
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { haversineMeters } from "@aprscaching/aprs";
import { DEFAULT_POLICY } from "./verify.js";
import { listEnabledPeers, keysForOrigin } from "./federation_sync.js";
import { parseAttestedSites } from "./provenance.js";
import { isInstanceId, loadRegistry } from "./federation.js";
import { signFedRecord, verifyFedFrame } from "./fedcbor.js";
import { bodyFromWire, bodyToWire } from "./fedsync.js";
import { decodeFedFrame } from "@aprscaching/shared";
import {
  coarsenConfig,
  snapToGrid,
  gridSlackM,
  bucketWindow,
  distanceBucketM,
  bucketTs,
  corroborationAuthorized,
  clientIp,
  rateLimitedDurable,
  negCached,
  negStore,
} from "./corroborate_privacy.js";

/** Cap the peers probed per find — a bounded fan-out budget. */
const CORROBORATION_FANOUT = 16;

export interface Evidence {
  instance: string;
  /** Who stands behind this answer: its registry operator when there is one, else its signing key.
   *  The quorum counts distinct identities, never self-reported instance names. */
  identity?: string;
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
  /** Base calls the logger controls; a position gated by any of them never corroborates. */
  excludeIgates?: string[];
}

/** Advertised in the descriptor: this instance speaks the signed corroboration exchange. */
export const CORROBORATE_CAPABILITY = "corroborate-signed/1";
/** How far a signed question or answer's `at` may sit from the receiver's clock. */
const CORROBORATION_SKEW_S = 120;
/** The answerer's bounds on a question: radius, window length, and how far back it may reach. */
export const ANSWER_MIN_RADIUS_M = 150;
export const ANSWER_MAX_RADIUS_M = 1000;
export const ANSWER_MAX_WINDOW_S = 3600;
export const ANSWER_MAX_AGE_S = 7 * 86400;
const MAX_QUESTION_BYTES = 16 * 1024;
const CALL_RE = /^[A-Z0-9]{1,7}(?:-[A-Z0-9]{1,2})?$/;

const hexOf = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function payloadHash(payload: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", payload));
}
/** A corroborator's identity for the quorum: its registry operator when known, else its signing key. */
function identityOf(operator: string | undefined, key: string): string {
  return operator ? `operator:${operator.toUpperCase()}` : `key:${key}`;
}
function newNonce(): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
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

export interface RfPositionRow {
  lat: number;
  lon: number;
  ts: number;
  igate_call: string | null;
}

/**
 * Pick the evidence a set of this instance's RF positions offers for a corroboration query, or null.
 *
 * Only a receiving site this instance attests (FIRST_PARTY_SITES) can vouch for a position — the same
 * default-deny rule as local Tier A, so an empty list vouches for nothing. A peer's corroboration can lift
 * a find to Tier A there, so answering from a site nobody here stands behind would let transport
 * masquerade as trust. A site the logger controls, or one the asker excludes, never counts.
 */
export function pickLocalEvidence(
  rows: RfPositionRow[],
  q: Pick<CorroborationQuery, "callsign" | "lat" | "lon" | "radiusM">,
  excludeIgates: Set<string>,
  attested: Set<string>,
): Omit<Evidence, "instance"> | null {
  if (attested.size === 0) return null;
  const radius = Math.min(q.radiusM || DEFAULT_POLICY.radiusM, 1000);
  const callBase = baseCall(q.callsign);
  for (const r of rows) {
    const ig = r.igate_call ?? "";
    if (!ig || !attested.has(ig.toUpperCase())) continue; // no site, or one this instance doesn't attest
    const igBase = baseCall(ig);
    if (igBase === callBase || excludeIgates.has(igBase)) continue; // self-gated / excluded
    const d = haversineMeters(r.lat, r.lon, q.lat, q.lon);
    if (d <= radius) return { igateCall: ig, distanceM: d, ts: r.ts };
  }
  return null;
}

/** Search THIS instance's RF positions for an independent corroboration. Returns evidence or null. */
async function localCorroboration(
  env: Env,
  q: CorroborationQuery,
  excludeIgates: Set<string>,
): Promise<Omit<Evidence, "instance"> | null> {
  const attested = parseAttestedSites(env.FIRST_PARTY_SITES);
  if (attested.size === 0) return null;
  const rows = (
    await env.DB.prepare(
      `SELECT lat, lon, ts, igate_call FROM positions
      WHERE callsign = ? AND heard_via = 'rf' AND source != 'service' AND ts BETWEEN ? AND ?
      ORDER BY ts DESC LIMIT 500`,
    )
      .bind(q.callsign.toUpperCase(), q.since, q.until)
      .all<RfPositionRow>()
  ).results;
  return pickLocalEvidence(rows, q, excludeIgates, attested);
}

/** The negative-memo key: who asked, the callsign, the coarsened cell and window, the radius and the
 *  exclusions — a "no" to one question must never answer a wider or less-excluded one. */
function probeKey(asker: string, b: CorroborationQuery, exclude: Set<string>): string {
  return [asker, baseCall(b.callsign), b.lat, b.lon, b.radiusM, b.since, b.until, [...exclude].sort().join(",")].join(
    "|",
  );
}

/**
 * Bound a question before answering it (pure, exported for test): the centre is snapped to the grid,
 * the radius is clamped to [150 m, 1000 m], the window is bucketed and capped at an hour, and a
 * window that ended more than seven days ago is refused. Whatever the asker sends, the answer can
 * only say "roughly here, roughly then".
 */
export function boundQuestion(
  q: CorroborationQuery,
  cfg: ReturnType<typeof coarsenConfig>,
  nowS: number,
): CorroborationQuery | null {
  if (![q.lat, q.lon, q.since, q.until].every(Number.isFinite) || q.until < q.since) return null;
  const until = Math.min(q.until, nowS);
  if (until < nowS - ANSWER_MAX_AGE_S) return null;
  const c = snapToGrid(q.lat, q.lon, cfg.gridDeg);
  const w = bucketWindow(Math.max(q.since, until - ANSWER_MAX_WINDOW_S), until, cfg.timeBucketSec);
  const radius = Math.min(Math.max(Number(q.radiusM) || ANSWER_MIN_RADIUS_M, ANSWER_MIN_RADIUS_M), ANSWER_MAX_RADIUS_M);
  return { ...q, lat: c.lat, lon: c.lon, radiusM: radius + gridSlackM(cfg.gridDeg), since: w.since, until: w.until };
}

/**
 * Endpoint: a peer asks whether we independently heard a callsign on RF near a point in a window.
 *
 * The question is a signed fedwire frame (`corroborationQuery`) carrying a fresh nonce, and the reply
 * is a signed `corroboration` frame bound to that nonce and to the SHA-256 of the question's payload,
 * so a reply can never be replayed against another question. The asker is identified by its signing
 * key: a known peer by its stored key set, anyone else as an anonymous key (refused when
 * FED_CORROBORATION_REQUIRE_KNOWN is set; FED_CORROBORATION_SECRET adds a shared-secret gate). The
 * question is bounded ({@link boundQuestion}) and the answer coarsened — a distance bucket and a
 * bucketed time, the exact IGate only with FED_REVEAL_IGATE — and rate limits and the negative memo
 * are kept per asker.
 */
export async function handleCorroborate(req: Request, env: Env): Promise<Response> {
  if (!corroborationAuthorized(env, req)) return json({ corroborated: false, error: "unauthorized" }, { status: 401 });
  if (!(req.headers.get("content-type") ?? "").includes("application/cbor"))
    return json({ corroborated: false, error: "a corroboration question is a signed CBOR frame" }, { status: 415 });
  const us = env.INSTANCE;
  if (!us) return json({ corroborated: false, error: "no instance id" }, { status: 503 });
  // the per-host limit comes first, before any decoding or signature work
  if (await rateLimitedDurable(env, `ip:${clientIp(req, env)}`, Date.now()))
    return json({ corroborated: false, error: "rate limited" }, { status: 429 });
  const bytes = await readCappedBody(req, MAX_QUESTION_BYTES);
  if (!bytes) return json({ corroborated: false, error: "question too large" }, { status: 413 });

  let frame: ReturnType<typeof decodeFedFrame>;
  try {
    frame = decodeFedFrame(bytes);
  } catch {
    return json({ corroborated: false, error: "bad question" }, { status: 400 });
  }
  const rec = frame.record;
  const nowS = Math.floor(Date.now() / 1000);
  if (
    rec.kind !== "corroborationQuery" ||
    !isInstanceId(rec.origin) ||
    rec.signer !== rec.origin ||
    rec.body.target !== us ||
    Math.abs(rec.at - nowS) > CORROBORATION_SKEW_S
  )
    return json({ corroborated: false, error: "bad question" }, { status: 400 });

  // who is asking: a known peer by its verified key set, otherwise an anonymous key
  const known = await keysForOrigin(env, rec.origin);
  if (known === "blocked") return json({ corroborated: false, error: "blocked" }, { status: 403 });
  let asker: string;
  if (known.length) {
    if (!(await verifyFedFrame(bytes, known)))
      return json({ corroborated: false, error: "question does not verify" }, { status: 401 });
    asker = rec.origin;
  } else {
    if (env.FED_CORROBORATION_REQUIRE_KNOWN === "1")
      return json({ corroborated: false, error: "unknown asker" }, { status: 401 });
    if (!(await verifyFedFrame(bytes, [frame.signerKey])))
      return json({ corroborated: false, error: "question does not verify" }, { status: 401 });
    asker = `key:${frame.signerKey}`;
  }

  const b = bodyFromWire(rec.body) as Partial<CorroborationQuery> & { nonce?: unknown };
  if (typeof b.callsign !== "string" || typeof b.nonce !== "string" || b.nonce.length > 64)
    return json({ corroborated: false, error: "bad question" }, { status: 400 });
  const cfg = coarsenConfig(env);
  const bounded = boundQuestion(b as CorroborationQuery, cfg, nowS);
  if (!bounded) return json({ corroborated: false, error: "window out of range" }, { status: 400 });

  const nowMs = Date.now();
  if (
    (await rateLimitedDurable(env, `asker:${asker}`, nowMs)) ||
    (await rateLimitedDurable(env, `call:${asker}:${baseCall(bounded.callsign)}`, nowMs))
  )
    return json({ corroborated: false, error: "rate limited" }, { status: 429 });

  const exclude = new Set((Array.isArray(b.excludeIgates) ? b.excludeIgates : []).map((c) => baseCall(String(c))));
  const key = probeKey(asker, bounded, exclude);
  let body: Record<string, unknown> = { corroborated: false };
  if (!negCached(key, nowMs)) {
    const ev = await localCorroboration(env, bounded, exclude);
    if (ev) {
      body = {
        corroborated: true,
        distanceM: distanceBucketM(ev.distanceM, cfg.distBucketM),
        ts: bucketTs(ev.ts, cfg.timeBucketSec),
        ...(env.FED_REVEAL_IGATE && ev.igateCall ? { igateCall: ev.igateCall } : {}),
      };
    } else negStore(key, nowMs);
  }
  const answer = await signFedRecord(env, {
    kind: "corroboration",
    gid: `${us}:corroboration:${b.nonce}`,
    origin: us,
    v: nowS,
    at: nowS,
    signer: us,
    body: bodyToWire({ ...body, nonce: b.nonce, queryHash: await payloadHash(frame.payload) }),
  });
  if (!answer) return json({ corroborated: false, error: "this instance has no signing key" }, { status: 503 });
  return new Response(answer as BodyInit, { headers: { "content-type": "application/cbor" } });
}

/**
 * Quorum decision (pure, testable): require corroboration from **≥ quorum DISTINCT
 * identities** before a find may reach Tier A. De-dupes by identity — the registry operator, else
 * the signing key — so one operator or one key answering under several instance ids is one voice
 * and no single party can mint Tier A; below quorum returns null. Returns the closest evidence,
 * annotated with how many independent identities corroborated.
 */
export function selectCorroboration(hits: Evidence[], quorum: number): Evidence | null {
  const need = Math.max(1, Math.floor(quorum) || 1);
  const byInstance = new Map<string, Evidence>();
  for (const h of hits) {
    const who = h.identity ?? h.instance;
    const prev = byInstance.get(who);
    if (!prev || h.distanceM < prev.distanceM) byInstance.set(who, h); // keep the closest per identity
  }
  if (byInstance.size < need) return null;
  const best = [...byInstance.values()].sort((a, b) => a.distanceM - b.distanceM)[0]!;
  return { ...best, corroborators: byInstance.size };
}

/** Auto-promotion rule (pure, testable): an unvetted peer that has earned enough confirmed
 *  corroborations (and no contradictions) crosses into `trusted`. threshold ≤ 0 disables it. */
export function shouldAutoPromote(trust: string, repConfirmed: number, repFailed: number, threshold: number): boolean {
  return threshold > 0 && trust === "unvetted" && repFailed === 0 && repConfirmed >= threshold;
}

/** Does a peer's evidence AGREE with the confirmed winner? Reputation only accrues for
 *  evidence that independently matches (same coarse distance/time buckets) — an always-yes peer that
 *  fabricates `corroborated:true` cannot guess the winner's buckets from the coarsened query, so it
 *  stops farming rep_confirmed toward auto-promotion. Pure + testable. */
export function evidenceMatches(
  ev: Pick<Evidence, "distanceM" | "ts">,
  winner: Pick<Evidence, "distanceM" | "ts">,
  cfg: { distBucketM: number; timeBucketSec: number },
): boolean {
  return (
    Math.abs((ev.distanceM ?? 0) - (winner.distanceM ?? 0)) <= cfg.distBucketM &&
    Math.abs((ev.ts ?? 0) - (winner.ts ?? 0)) <= cfg.timeBucketSec
  );
}

/** The effective quorum — when ANY auto-promoted peer contributed evidence to the winning
 *  set, a lone corroborator is not enough: a farmed promotion must never single-handedly mint Tier A.
 *  Pure + testable. */
export function effectiveQuorum(baseQuorum: number, autoPromotedContributed: boolean): number {
  return autoPromotedContributed ? Math.max(baseQuorum, 2) : Math.max(baseQuorum, 1);
}

/** Reward the peers whose corroboration was independently confirmed (the find reached Tier A): bump
 *  rep_confirmed, and auto-promote any unvetted peer that crosses the threshold. */
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
 * The contradiction signal: which probed peers DENIED a corroboration the trusted
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

/**
 * Check a peer's signed reply against the question it answers (pure apart from the signature check):
 * the frame verifies under the peer's key set, names the peer as origin and signer, is fresh, and
 * echoes our nonce and question hash. Evidence is rebuilt from whitelisted, range-checked fields —
 * the instance is the verified peer, the IGate is kept only when this instance opted into
 * FED_REVEAL_IGATE and it is not one of the logger's own. Returns the evidence, `"no"` for a verified
 * denial, or null for anything that does not verify.
 */
export async function acceptAnswer(
  bytes: Uint8Array,
  ctx: {
    instance: string;
    identity: string;
    keys: string[];
    nonce: string;
    queryHash: string;
    question: CorroborationQuery;
    revealIgate: boolean;
    distBucketM: number;
    timeBucketSec: number;
    nowS: number;
  },
): Promise<Evidence | "no" | null> {
  const f = await verifyFedFrame(bytes, ctx.keys);
  if (!f) return null;
  const r = f.record;
  if (r.kind !== "corroboration" || r.origin !== ctx.instance || r.signer !== ctx.instance) return null;
  if (Math.abs(r.at - ctx.nowS) > CORROBORATION_SKEW_S) return null;
  const b = bodyFromWire(r.body);
  if (b.nonce !== ctx.nonce || b.queryHash !== ctx.queryHash) return null;
  if (b.corroborated !== true) return b.corroborated === false ? "no" : null;
  const d = Number(b.distanceM);
  const ts = Number(b.ts);
  const q = ctx.question;
  if (!Number.isFinite(d) || d < 0 || d > q.radiusM + ctx.distBucketM) return null;
  if (!Number.isInteger(ts) || ts < q.since - ctx.timeBucketSec || ts > q.until + 60) return null;
  const ev: Evidence = { instance: ctx.instance, identity: ctx.identity, distanceM: d, ts };
  const ig = typeof b.igateCall === "string" ? b.igateCall.toUpperCase() : "";
  const excluded = new Set((q.excludeIgates ?? []).map(baseCall));
  if (ctx.revealIgate && CALL_RE.test(ig) && !excluded.has(baseCall(ig)) && baseCall(ig) !== baseCall(q.callsign))
    ev.igateCall = ig;
  return ev;
}

/**
 * Client: ask peers to corroborate **in parallel**, then apply the quorum gate (default 2 distinct
 * identities; `FED_CORROBORATION_QUORUM` sets it). Only **`trusted`** peers count toward Tier A:
 * `unvetted` peers are probed advisorily (to earn trust) only when FED_AUTO_PROMOTE is on, and
 * `blocked` peers are already filtered out by `listEnabledPeers`. Each question is signed with this
 * instance's key and carries a fresh nonce; a reply counts only if it verifies ({@link acceptAnswer}).
 * The shared FED_CORROBORATION_SECRET, when set, rides only to trusted https peers.
 */
export async function queryPeerCorroboration(env: Env, q: CorroborationQuery): Promise<Evidence | null> {
  const quorum = Number(env.FED_CORROBORATION_QUORUM ?? 2);
  const threshold = Number(env.FED_AUTO_PROMOTE ?? 0);
  const us = env.INSTANCE;
  if (!us) return null;
  // trusted peers count toward Tier A; when reputation/promotion is enabled, unvetted peers are also
  // probed but ONLY advisorily — their hits never reach quorum, they just let an unvetted peer EARN
  // trust by agreeing with confirmed corroborations. Default (threshold 0) = trusted-only. A peer with
  // no bound instance has no verifiable identity and is never asked.
  const pool = (await listEnabledPeers(env))
    .filter((p) => p.instance && p.instance !== us)
    .filter((p) => p.trust === "trusted" || (threshold > 0 && p.trust === "unvetted"))
    .slice(0, CORROBORATION_FANOUT); // bounded fan-out budget
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return null; // a misconfigured registry lends no identity to anyone
  }

  // good-citizen request coarsening: snap the center to a grid cell, widen the radius to cover the
  // snap, bucket the time window — peers never see our exact lat/lon/second.
  const cfg = coarsenConfig(env);
  const c = snapToGrid(q.lat, q.lon, cfg.gridDeg);
  const w = bucketWindow(q.since, q.until, cfg.timeBucketSec);
  const cq: CorroborationQuery = {
    callsign: q.callsign,
    lat: c.lat,
    lon: c.lon,
    radiusM: (q.radiusM || DEFAULT_POLICY.radiusM) + gridSlackM(cfg.gridDeg),
    since: w.since,
    until: w.until,
    excludeIgates: [...new Set((q.excludeIgates ?? []).map(baseCall))],
  };

  const probes = await Promise.all(
    pool.map(async (peer): Promise<{ peer: (typeof pool)[number]; ev: Evidence | null; denied: boolean }> => {
      const none = { peer, ev: null, denied: false }; // unavailable or unverifiable ≠ contradiction
      const instance = peer.instance as string;
      const keys = await keysForOrigin(env, instance);
      if (keys === "blocked" || !keys.length) return none;
      const nowS = Math.floor(Date.now() / 1000);
      const nonce = newNonce();
      const question = await signFedRecord(env, {
        kind: "corroborationQuery",
        gid: `${us}:corroborationQuery:${nonce}`,
        origin: us,
        v: nowS,
        at: nowS,
        signer: us,
        body: bodyToWire({ ...cq, nonce, target: instance }),
      });
      if (!question) return none; // an instance without a signing key cannot ask
      const base = trimTrailingSlashes(peer.url);
      const headers: Record<string, string> = { "content-type": "application/cbor", accept: "application/cbor" };
      if (env.FED_CORROBORATION_SECRET && peer.trust === "trusted" && base.startsWith("https://"))
        headers["x-fed-secret"] = env.FED_CORROBORATION_SECRET;
      try {
        const r = await fedFetch(env, `${base}/federation/corroborate`, {
          method: "POST",
          headers,
          body: question as BodyInit,
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) return none;
        const verdict = await acceptAnswer(new Uint8Array(await r.arrayBuffer()), {
          instance,
          identity: identityOf(registry.get(instance)?.operator, peer.public_key ?? keys[0]!),
          keys,
          nonce,
          queryHash: await payloadHash(decodeFedFrame(question).payload),
          question: cq,
          revealIgate: !!env.FED_REVEAL_IGATE,
          distBucketM: cfg.distBucketM,
          timeBucketSec: cfg.timeBucketSec,
          nowS: Math.floor(Date.now() / 1000),
        });
        if (verdict === "no") return { peer, ev: null, denied: true }; // an explicit, verified "no"
        return verdict ? { peer, ev: verdict, denied: false } : none;
      } catch {
        return none;
      }
    }),
  );

  // Tier A is decided from TRUSTED hits only; unvetted hits are advisory. When an
  // auto-promoted peer is among the evidence-bearing trusted set, one voice is not enough — a
  // farmed promotion must corroborate ALONGSIDE an operator-vetted peer, never alone.
  const autoPromotedContributed = probes.some(
    (x) => x.ev && x.peer.trust === "trusted" && x.peer.added_via === "auto-promoted",
  );
  const trustedHits = probes.filter((x) => x.ev && x.peer.trust === "trusted").map((x) => x.ev as Evidence);
  const winner = selectCorroboration(trustedHits, effectiveQuorum(quorum, autoPromotedContributed));
  if (winner) {
    // reputation accrues ONLY for evidence that independently matches the confirmed
    // winner — answering "yes" with fabricated evidence no longer farms rep toward promotion.
    await creditCorroboration(
      env,
      probes.filter((x) => x.ev && evidenceMatches(x.ev, winner, cfg)).map((x) => x.peer.url),
      threshold,
    );
    // contradiction signal: peers that DENIED a corroboration the trusted quorum confirmed lose rep.
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
