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
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import { b64urlToBytes, bytesToB64url } from "./util/b64.js";
import { syncAddresses } from "./fedtransport.js";
import { flagOn, type Env } from "./env.js";
import { json } from "./app.js";
import { baseCall, haversineMeters } from "@aprscaching/aprs";
import { DEFAULT_POLICY } from "./verify.js";
import { listEnabledPeers, keysForOrigin, type PeerRow } from "./fedpeers.js";
import { provenanceOf } from "./provenance.js";
import { attestation, sitesFor, type Attestation } from "./attestedsites.js";
import { isInstanceId, loadRegistry, type RegistryEntry } from "./federation.js";
import {
  enqueueRelayQuery,
  instanceRequester,
  isRelaySpoke,
  localRelayResult,
  signRelayRequest,
  SELF_REQUESTER,
} from "./relay.js";
import { signFedRecord, verifyFedFrame } from "./fedcbor.js";
import { bodyFromWire, bodyToWire } from "./fedsync.js";
import { decodeFedFrame } from "@aprscaching/shared";
import {
  COARSEN,
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
/** Addresses of one peer a corroboration question tries before the peer counts as not reached. */
const MAX_ASK_ADDRESSES = 3;

export interface Evidence {
  instance: string;
  /** Who stands behind this answer: its registry operator, else its ARDC-verified 44net call, else its
   *  signing key. The quorum counts distinct identities, never self-reported instance names. */
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

/** How far a signed question or answer's `at` may sit from the receiver's clock. */
const CORROBORATION_SKEW_S = 120;
/** The answerer's bounds on a question: radius, window length, and how far back it may reach. */
const ANSWER_MIN_RADIUS_M = 150;
const ANSWER_MAX_RADIUS_M = 1000;
const ANSWER_MAX_WINDOW_S = 3600;
const ANSWER_MAX_AGE_S = 7 * 86400;
const MAX_QUESTION_BYTES = 16 * 1024;
const CALL_RE = /^[A-Z0-9]{1,7}(?:-[A-Z0-9]{1,2})?$/;

const hexOf = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function payloadHash(payload: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", payload));
}
/**
 * A corroborator's identity for the quorum: its registry operator when known, else the callsign ARDC
 * verified when it was added over 44net, else its signing key.
 */
function identityOf(operator: string | undefined, key: string): string {
  return operator ? `operator:${operator.toUpperCase()}` : `key:${key}`;
}
function newNonce(): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
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

interface RfPositionRow {
  lat: number;
  lon: number;
  ts: number;
  heard_via: string;
  igate_call: string | null;
  path: string | null;
  transport: string | null;
  /** the enrolled box that delivered it (positions.ingest_box) */
  ingest_box?: string | null;
}

/**
 * Pick the evidence a set of this instance's RF positions offers for a corroboration query, or null.
 *
 * Only a position first-party attested by the same rule as local Tier A ({@link provenanceOf}) can vouch:
 * heard by a receiving site this instance attests (FIRST_PARTY_SITES or a trusted station) through that site's own on-air
 * ingest. An empty list vouches for nothing, and an APRS-IS copy naming an attested site never vouches. A peer's corroboration can lift
 * a find to Tier A there, so answering from a site nobody here stands behind would let transport
 * masquerade as trust. A site the logger controls, or one the asker excludes, never counts.
 */
export function pickLocalEvidence(
  rows: RfPositionRow[],
  q: Pick<CorroborationQuery, "callsign" | "lat" | "lon" | "radiusM">,
  excludeIgates: Set<string>,
  attested: Attestation | Set<string>,
): Omit<Evidence, "instance"> | null {
  const a: Attestation = attested instanceof Set ? { shared: attested, byBox: new Map() } : attested;
  if (a.shared.size === 0 && a.byBox.size === 0) return null;
  const radius = Math.min(q.radiusM || DEFAULT_POLICY.radiusM, 1000);
  const callBase = baseCall(q.callsign);
  for (const r of rows) {
    if (!provenanceOf(r, sitesFor(a, r.ingest_box)).firstPartyAttested) continue; // not heard by a site this instance attests
    const ig = r.igate_call ?? "";
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
  const attested = await attestation(env);
  if (attested.shared.size === 0 && attested.byBox.size === 0) return null;
  const rows = (
    await env.DB.prepare(
      `SELECT lat, lon, ts, heard_via, igate_call, path, transport, ingest_box FROM positions
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
function boundQuestion(q: CorroborationQuery, cfg: typeof COARSEN, nowS: number): CorroborationQuery | null {
  if (![q.lat, q.lon, q.since, q.until].every(Number.isFinite) || q.until < q.since) return null;
  const until = Math.min(q.until, nowS);
  if (until < nowS - ANSWER_MAX_AGE_S) return null;
  const c = snapToGrid(q.lat, q.lon, cfg.gridDeg);
  const w = bucketWindow(Math.max(q.since, until - ANSWER_MAX_WINDOW_S), until, cfg.timeBucketSec);
  const radius = Math.min(Math.max(Number(q.radiusM) || ANSWER_MIN_RADIUS_M, ANSWER_MIN_RADIUS_M), ANSWER_MAX_RADIUS_M);
  return { ...q, lat: c.lat, lon: c.lon, radiusM: radius + gridSlackM(cfg.gridDeg), since: w.since, until: w.until };
}

/** How long a relayed question stays answerable: the spoke collects it on its next poll, and its hub
 *  drops an unanswered query after an hour. */
const RELAYED_MAX_AGE_S = 3600;

/** A signed answer, or why there is none, with the HTTP status a direct asker gets. */
type QuestionOutcome = { frame: Uint8Array } | { status: number; error: string };

/**
 * Answer one signed corroboration question, delivered directly or through a hub's relay.
 *
 * The question is a signed fedwire frame (`corroborationQuery`) carrying a fresh nonce, and the reply
 * is a signed `corroboration` frame bound to that nonce and to the SHA-256 of the question's payload,
 * so a reply can never be replayed against another question. The asker is identified by its signing
 * key: a known peer by its stored key set, anyone else as an anonymous key (refused when
 * FED_CORROBORATION_REQUIRE_KNOWN is set). The question is bounded ({@link boundQuestion}) and the answer
 * coarsened — a distance bucket and a bucketed time, the exact IGate only with FED_REVEAL_IGATE — and rate
 * limits and the negative memo are kept per asker. A direct question must be fresh to two minutes; a
 * relayed one waited in the hub's queue, so it may be up to an hour old. The shared FED_CORROBORATION_SECRET
 * cannot ride the relay (the hub would read it), so with it set a relayed question is answered only for a
 * known asker.
 */
export async function answerQuestion(
  env: Env,
  bytes: Uint8Array,
  opts: { relayed?: boolean } = {},
): Promise<QuestionOutcome> {
  const us = env.INSTANCE;
  if (!us) return { status: 503, error: "no instance id" };
  const bad = { status: 400, error: "bad question" };
  let frame: ReturnType<typeof decodeFedFrame>;
  try {
    frame = decodeFedFrame(bytes);
  } catch {
    return bad;
  }
  const rec = frame.record;
  const now = nowS();
  const fresh = opts.relayed
    ? rec.at >= now - RELAYED_MAX_AGE_S && rec.at <= now + CORROBORATION_SKEW_S
    : Math.abs(rec.at - now) <= CORROBORATION_SKEW_S;
  if (
    rec.kind !== "corroborationQuery" ||
    !isInstanceId(rec.origin) ||
    rec.signer !== rec.origin ||
    rec.body.target !== us ||
    !fresh
  )
    return bad;

  // who is asking: a known peer by its verified key set, otherwise an anonymous key
  const known = await keysForOrigin(env, rec.origin);
  if (known === "blocked") return { status: 403, error: "blocked" };
  let asker: string;
  if (known.length) {
    if (!(await verifyFedFrame(bytes, known))) return { status: 401, error: "question does not verify" };
    asker = rec.origin;
  } else {
    if (env.FED_CORROBORATION_REQUIRE_KNOWN === "1" || (opts.relayed && env.FED_CORROBORATION_SECRET))
      return { status: 401, error: "unknown asker" };
    if (!(await verifyFedFrame(bytes, [frame.signerKey]))) return { status: 401, error: "question does not verify" };
    asker = `key:${frame.signerKey}`;
  }

  const b = bodyFromWire(rec.body) as Partial<CorroborationQuery> & { nonce?: unknown };
  if (typeof b.callsign !== "string" || typeof b.nonce !== "string" || b.nonce.length > 64) return bad;
  const cfg = COARSEN;
  const bounded = boundQuestion(b as CorroborationQuery, cfg, now);
  if (!bounded) return { status: 400, error: "window out of range" };

  const nowMs = Date.now();
  if (
    (await rateLimitedDurable(env, `asker:${asker}`, nowMs)) ||
    (await rateLimitedDurable(env, `call:${asker}:${baseCall(bounded.callsign)}`, nowMs))
  )
    return { status: 429, error: "rate limited" };

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
        ...(flagOn(env.FED_REVEAL_IGATE) && ev.igateCall ? { igateCall: ev.igateCall } : {}),
      };
    } else negStore(key, nowMs);
  }
  const answer = await signFedRecord(env, {
    kind: "corroboration",
    gid: `${us}:corroboration:${b.nonce}`,
    origin: us,
    v: now,
    at: now,
    signer: us,
    body: bodyToWire({ ...body, nonce: b.nonce, queryHash: await payloadHash(frame.payload) }),
  });
  if (!answer) return { status: 503, error: "this instance has no signing key" };
  return { frame: answer };
}

/** The instance a corroboration question is addressed to, or null when the bytes are not one. */
function questionTarget(bytes: Uint8Array): string | null {
  try {
    const rec = decodeFedFrame(bytes).record;
    return rec.kind === "corroborationQuery" && typeof rec.body.target === "string" ? rec.body.target : null;
  } catch {
    return null;
  }
}

/**
 * A hub passes on a question addressed to one of its push spokes: the spoke cannot be dialled, so the
 * question waits in the relay queue until the spoke collects it, and the asker collects the spoke's signed
 * answer with the ticket it gets here (202). The hub forwards only for an asker it knows, whose question
 * verifies under that asker's keys, and within the relay's per-requester caps; it never reads or alters
 * the answer, which is bound to the asker's nonce and checked by the asker.
 */
async function forwardToSpoke(env: Env, bytes: Uint8Array, target: string): Promise<Response> {
  if (!isInstanceId(target) || !(await isRelaySpoke(env, target)))
    return json({ corroborated: false, error: "not a spoke of this hub" }, { status: 404 });
  const rec = decodeFedFrame(bytes).record;
  if (
    !isInstanceId(rec.origin) ||
    rec.signer !== rec.origin ||
    rec.origin === target ||
    Math.abs(rec.at - nowS()) > CORROBORATION_SKEW_S
  )
    return json({ corroborated: false, error: "bad question" }, { status: 400 });
  const known = await keysForOrigin(env, rec.origin);
  if (known === "blocked") return json({ corroborated: false, error: "blocked" }, { status: 403 });
  if (!known.length) return json({ corroborated: false, error: "unknown asker" }, { status: 401 });
  if (!(await verifyFedFrame(bytes, known)))
    return json({ corroborated: false, error: "question does not verify" }, { status: 401 });
  const r = await enqueueRelayQuery(
    env,
    target,
    { kind: "corroborate", params: { question: bytesToB64url(bytes) } },
    instanceRequester(rec.origin),
  );
  if ("error" in r) return json({ corroborated: false, error: r.error }, { status: r.status });
  return json({ relayed: true, id: r.id, ticket: r.ticket }, { status: 202 });
}

/**
 * Endpoint: a peer asks whether we independently heard a callsign on RF near a point in a window
 * ({@link answerQuestion}), or, as a hub, passes a question on to one of our push spokes
 * ({@link forwardToSpoke}). FED_CORROBORATION_SECRET adds a shared-secret gate to both.
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
  const target = questionTarget(bytes);
  if (target !== null && target !== us) return forwardToSpoke(env, bytes, target);
  const r = await answerQuestion(env, bytes);
  if ("frame" in r) return new Response(r.frame as BodyInit, { headers: { "content-type": "application/cbor" } });
  return json({ corroborated: false, error: r.error }, { status: r.status });
}

/**
 * Quorum decision (pure, testable): require corroboration from **≥ quorum DISTINCT
 * identities** before a find may reach Tier A. De-dupes by identity — the registry operator, else the
 * ARDC-verified 44net call, else the signing key — so one operator or one key answering under several
 * instance ids is one voice and no single party can mint Tier A; below quorum returns null. Returns the
 * closest evidence, annotated with how many independent identities corroborated.
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
  const at = nowS();
  for (const url of new Set(urls)) {
    await env.DB.prepare("UPDATE fed_peers SET rep_confirmed = rep_confirmed + 1 WHERE url = ?").bind(url).run();
    if (threshold <= 0) continue;
    await env.DB.prepare(
      // added_via keeps how the peer arrived; auto_promoted_at marks the promotion as corroboration's own
      "UPDATE fed_peers SET trust='trusted', auto_promoted_at=?, approved_at=COALESCE(approved_at,?) WHERE url=? AND trust='unvetted' AND rep_failed=0 AND rep_confirmed >= ?",
    )
      .bind(at, at, url, threshold)
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
 * FED_REVEAL_IGATE and it is not one of the logger's own. A relayed answer was signed when the spoke
 * collected the question, so it must fall between the time the question was asked (`askedAt`) and now.
 * Returns the evidence, `"no"` for a verified denial, or null for anything that does not verify.
 */
async function acceptAnswer(
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
    askedAt?: number;
  },
): Promise<Evidence | "no" | null> {
  const f = await verifyFedFrame(bytes, ctx.keys);
  if (!f) return null;
  const r = f.record;
  if (r.kind !== "corroboration" || r.origin !== ctx.instance || r.signer !== ctx.instance) return null;
  const fresh =
    ctx.askedAt !== undefined
      ? r.at >= ctx.askedAt - CORROBORATION_SKEW_S && r.at <= ctx.nowS + CORROBORATION_SKEW_S
      : Math.abs(r.at - ctx.nowS) <= CORROBORATION_SKEW_S;
  if (!fresh) return null;
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

/** One trusted peer's evidence, kept by the peer's URL so a later attempt can check its trust again. */
export interface PeerHit {
  url: string;
  ev: Evidence;
}

/**
 * A question waiting in a hub's relay queue for a peer nobody can dial: the hub it waits at (empty when
 * this instance is the hub), the id and ticket its answer is read with, and what the answer must echo.
 */
export interface RelayedAsk {
  /** The peer row asked. */
  url: string;
  instance: string;
  /** The hub's base URL, or "" for this instance's own queue. */
  hub: string;
  id: number;
  ticket: string;
  nonce: string;
  queryHash: string;
  askedAt: number;
}

/** What one round of asking found, and what a later attempt needs. */
interface CorroborationOutcome {
  /** The Tier-A evidence, or null below quorum. */
  winner: Evidence | null;
  /** Trusted peers' evidence in hand, this round's and any carried in. */
  hits: PeerHit[];
  /** Trusted peers that could not be reached: the request failed in transit, timed out, or met a 429 or 5xx. */
  unreachable: string[];
  /** Whether a trusted peer answered with a verified "no". */
  denied: boolean;
  /** Trusted peers asked through a hub's relay: their answers arrive once the spoke collects the question. */
  relayed: RelayedAsk[];
}

/** Hubs a question for a peer nobody can dial is offered to, besides this instance's own relay. */
const MAX_RELAY_HUBS = 3;

/**
 * The peers a corroboration question may go to: the enabled peers, and the push spokes of this hub, which
 * are never pulled but answer through the relay. One row per instance, a row with an address first.
 */
async function corroborationPeers(env: Env): Promise<PeerRow[]> {
  const spokes = (
    await env.DB.prepare("SELECT * FROM fed_peers WHERE url LIKE 'submit:%' AND trust != 'blocked'").all<PeerRow>()
  ).results;
  const seen = new Set<string>();
  const out: PeerRow[] = [];
  for (const p of [...(await listEnabledPeers(env)), ...spokes]) {
    if (!p.instance || seen.has(p.instance)) continue;
    seen.add(p.instance);
    out.push(p);
  }
  return out;
}

/** A hub that may hold a relay queue for a spoke: this instance's own `FED_HUB_URL`, then trusted peers. */
interface RelayHub {
  baseUrl: string;
  instance: string | null;
  /** The shared FED_CORROBORATION_SECRET rides along: a trusted peer over https. */
  secret: boolean;
}
function relayHubs(env: Env, peers: PeerRow[]): RelayHub[] {
  const out: RelayHub[] = [];
  const add = (baseUrl: string, row: PeerRow | undefined) => {
    if (out.some((h) => h.baseUrl === baseUrl)) return;
    out.push({
      baseUrl,
      instance: row?.instance ?? null,
      secret: row?.trust === "trusted" && baseUrl.startsWith("https://"),
    });
  };
  const own = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : null;
  if (own)
    add(
      own,
      peers.find((p) => p.url === own),
    );
  for (const p of peers) {
    const a = p.trust === "trusted" ? syncAddresses(p)[0] : undefined;
    if (a) add(a.baseUrl, p);
  }
  return out;
}

/**
 * Leave a signed question for a peer nobody can dial in a hub's relay queue: this instance's own, when
 * the peer is one of its push spokes, else the first hub that takes it ({@link forwardToSpoke} answers 202
 * with a ticket). Null when no hub relays for the peer.
 */
async function askViaRelay(
  env: Env,
  instance: string,
  question: Uint8Array,
  hubs: RelayHub[],
): Promise<Pick<RelayedAsk, "hub" | "id" | "ticket"> | null> {
  if (await isRelaySpoke(env, instance)) {
    const r = await enqueueRelayQuery(
      env,
      instance,
      { kind: "corroborate", params: { question: bytesToB64url(question) } },
      SELF_REQUESTER,
    );
    return "error" in r ? null : { hub: "", id: r.id, ticket: r.ticket };
  }
  for (const h of hubs.filter((x) => x.instance !== instance).slice(0, MAX_RELAY_HUBS)) {
    const headers: Record<string, string> = { "content-type": "application/cbor" };
    if (h.secret && env.FED_CORROBORATION_SECRET) headers["x-fed-secret"] = env.FED_CORROBORATION_SECRET;
    try {
      const res = await fedFetch(env, `${h.baseUrl}/federation/corroborate`, {
        method: "POST",
        headers,
        body: question as BodyInit,
        signal: AbortSignal.timeout(3000),
      });
      if (res.status !== 202) continue; // this hub does not relay for the peer
      const b = (await res.json().catch(() => null)) as { relayed?: unknown; id?: unknown; ticket?: unknown } | null;
      if (b?.relayed === true && Number.isInteger(b.id) && typeof b.ticket === "string")
        return { hub: h.baseUrl, id: b.id as number, ticket: b.ticket };
    } catch {
      /* the next hub */
    }
  }
  return null;
}

/** Good-citizen coarsening: the centre snapped to a grid cell, the radius widened to cover the snap, the
 *  window bucketed — peers never see our exact lat/lon/second. Deterministic, so a later attempt asks the
 *  identical question. */
function coarsenQuestion(q: CorroborationQuery): CorroborationQuery {
  const cfg = COARSEN;
  const c = snapToGrid(q.lat, q.lon, cfg.gridDeg);
  const w = bucketWindow(q.since, q.until, cfg.timeBucketSec);
  return {
    callsign: q.callsign,
    lat: c.lat,
    lon: c.lon,
    radiusM: (q.radiusM || DEFAULT_POLICY.radiusM) + gridSlackM(cfg.gridDeg),
    since: w.since,
    until: w.until,
    excludeIgates: [...new Set((q.excludeIgates ?? []).map(baseCall))],
  };
}

/** The identity a peer's answer counts under in the quorum. */
function peerIdentity(registry: Map<string, RegistryEntry>, peer: PeerRow, keys: string[]): string {
  return identityOf(
    registry.get(peer.instance as string)?.operator ?? peer.operator_call ?? undefined,
    peer.public_key ?? keys[0]!,
  );
}

/** One peer's part in a round: its evidence, a verified "no", or neither. */
interface Answered {
  url: string;
  trust: string;
  ev: Evidence | null;
  denied: boolean;
}

/**
 * Apply the quorum to the evidence in hand and settle reputation. Tier A is decided from TRUSTED hits
 * only; unvetted hits are advisory. When an auto-promoted peer is among the evidence-bearing trusted
 * set, one voice is not enough — a farmed promotion must corroborate ALONGSIDE an operator-vetted peer,
 * never alone. A hit carried in counts only while its peer is still trusted.
 */
async function decide(
  env: Env,
  peers: PeerRow[],
  prior: PeerHit[],
  answered: Answered[],
): Promise<{ winner: Evidence | null; hits: PeerHit[] }> {
  const quorum = Number(env.FED_CORROBORATION_QUORUM ?? 2);
  const threshold = Number(env.FED_AUTO_PROMOTE ?? 0);
  const trustedNow = new Map(peers.filter((p) => p.trust === "trusted").map((p) => [p.url, p]));
  const hits: PeerHit[] = [
    ...prior.filter((h) => trustedNow.has(h.url) && !answered.some((a) => a.url === h.url)),
    ...answered.filter((a) => a.ev && a.trust === "trusted").map((a) => ({ url: a.url, ev: a.ev as Evidence })),
  ];
  const autoPromotedContributed = hits.some((h) => trustedNow.get(h.url)?.auto_promoted_at != null);
  const winner = selectCorroboration(
    hits.map((h) => h.ev),
    effectiveQuorum(quorum, autoPromotedContributed),
  );
  if (winner) {
    // reputation accrues ONLY for evidence that independently matches the confirmed
    // winner — answering "yes" with fabricated evidence no longer farms rep toward promotion.
    await creditCorroboration(
      env,
      answered.filter((a) => a.ev && evidenceMatches(a.ev, winner, COARSEN)).map((a) => a.url),
      threshold,
    );
    // contradiction signal: peers that DENIED a corroboration the trusted quorum confirmed lose rep.
    await debitContradiction(env, contradictors(answered, true));
  }
  return { winner, hits };
}

/**
 * Client: ask peers to corroborate **in parallel**, then apply the quorum gate (default 2 distinct
 * identities; `FED_CORROBORATION_QUORUM` sets it). Only **`trusted`** peers count toward Tier A:
 * `unvetted` peers are probed advisorily (to earn trust) only when FED_AUTO_PROMOTE is on, and
 * `blocked` peers are never asked. Each question is signed with this instance's key and carries a fresh
 * nonce; a reply counts only if it verifies ({@link acceptAnswer}). The shared FED_CORROBORATION_SECRET,
 * when set, rides only to trusted https peers.
 */
export async function queryPeerCorroboration(env: Env, q: CorroborationQuery): Promise<Evidence | null> {
  return (await askPeers(env, q)).winner;
}

/**
 * The corroboration round behind {@link queryPeerCorroboration}, with what a later attempt needs.
 * A later attempt ({@link retryCorroborations}) asks only `onlyUrls` — trusted peers that were not
 * reached — and carries the evidence already in hand as `priorHits`; a prior hit counts only while its
 * peer is still trusted, so a peer demoted or blocked since then lends nothing.
 *
 * A trusted peer is asked at the addresses a sync uses. One that has none (a push spoke of this hub) or
 * whose addresses all fail to connect is asked through a hub's relay instead: this instance's own queue
 * when the peer is its push spoke, else its `FED_HUB_URL` or a trusted peer that relays for it. The
 * question is the same signed frame; the answer arrives once the spoke collects it, and
 * {@link collectRelayed} reads it.
 */
export async function askPeers(
  env: Env,
  q: CorroborationQuery,
  opts: { onlyUrls?: string[]; priorHits?: PeerHit[] } = {},
): Promise<CorroborationOutcome> {
  const nobody: CorroborationOutcome = { winner: null, hits: [], unreachable: [], denied: false, relayed: [] };
  const threshold = Number(env.FED_AUTO_PROMOTE ?? 0);
  const us = env.INSTANCE;
  if (!us) return nobody;
  // trusted peers count toward Tier A; when reputation/promotion is enabled, unvetted peers are also
  // probed but ONLY advisorily — their hits never reach quorum, they just let an unvetted peer EARN
  // trust by agreeing with confirmed corroborations. Default (threshold 0) = trusted-only. A peer with
  // no bound instance has no verifiable identity and is never asked. A later attempt asks trusted
  // peers only.
  const peers = (await corroborationPeers(env)).filter((p) => p.instance !== us);
  const only = opts.onlyUrls ? new Set(opts.onlyUrls) : null;
  const pool = peers
    .filter((p) => p.trust === "trusted" || (!only && threshold > 0 && p.trust === "unvetted"))
    .filter((p) => !only || only.has(p.url))
    .slice(0, CORROBORATION_FANOUT); // bounded fan-out budget
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return nobody; // a misconfigured registry lends no identity to anyone
  }
  const cfg = COARSEN;
  const cq = coarsenQuestion(q);
  const hubs = relayHubs(env, peers);

  type Probe = Answered & { unreachable: boolean; relayed?: RelayedAsk };
  const probes = await Promise.all(
    pool.map(async (peer): Promise<Probe> => {
      // unavailable or unverifiable ≠ contradiction; only a peer not reached is worth asking again
      const none: Probe = { url: peer.url, trust: peer.trust, ev: null, denied: false, unreachable: false };
      const instance = peer.instance as string;
      const keys = await keysForOrigin(env, instance);
      if (keys === "blocked" || !keys.length) return none;
      const now = nowS();
      const nonce = newNonce();
      const question = await signFedRecord(env, {
        kind: "corroborationQuery",
        gid: `${us}:corroborationQuery:${nonce}`,
        origin: us,
        v: now,
        at: now,
        signer: us,
        body: bodyToWire({ ...cq, nonce, target: instance }),
      });
      if (!question) return none; // an instance without a signing key cannot ask
      const queryHash = await payloadHash(decodeFedFrame(question).payload);
      // the peer is asked at the addresses a sync uses, in the same order: the first that answers at all
      let r: Response | null = null;
      for (const a of syncAddresses(peer).slice(0, MAX_ASK_ADDRESSES)) {
        const headers: Record<string, string> = { "content-type": "application/cbor", accept: "application/cbor" };
        if (env.FED_CORROBORATION_SECRET && peer.trust === "trusted" && a.baseUrl.startsWith("https://"))
          headers["x-fed-secret"] = env.FED_CORROBORATION_SECRET;
        try {
          r = await fedFetch(env, `${a.baseUrl}/federation/corroborate`, {
            method: "POST",
            headers,
            body: question as BodyInit,
            signal: AbortSignal.timeout(Math.min(a.timeoutMs, 3000)),
          });
          break;
        } catch {
          /* no connection: the next address */
        }
      }
      if (!r) {
        // nobody can dial it: a trusted peer's question waits for it at a hub's relay
        const via = peer.trust === "trusted" ? await askViaRelay(env, instance, question, hubs) : null;
        if (via) return { ...none, relayed: { url: peer.url, instance, ...via, nonce, queryHash, askedAt: now } };
        return { ...none, unreachable: true };
      }
      // a refusal (4xx) is an answer; a rate limit or a server error is a peer not reached
      if (!r.ok) return { ...none, unreachable: r.status === 429 || r.status >= 500 };
      try {
        const verdict = await acceptAnswer(new Uint8Array(await r.arrayBuffer()), {
          instance,
          identity: peerIdentity(registry, peer, keys),
          keys,
          nonce,
          queryHash,
          question: cq,
          revealIgate: flagOn(env.FED_REVEAL_IGATE),
          distBucketM: cfg.distBucketM,
          timeBucketSec: cfg.timeBucketSec,
          nowS: nowS(),
        });
        if (verdict === "no") return { ...none, denied: true }; // an explicit, verified "no"
        return verdict ? { ...none, ev: verdict } : none;
      } catch {
        return none;
      }
    }),
  );

  // a prior hit from a peer asked again this round gives way to its fresh answer
  const asked = probes.filter((x) => !x.relayed);
  const { winner, hits } = await decide(
    env,
    peers,
    (opts.priorHits ?? []).filter((h) => !pool.some((p) => p.url === h.url)),
    asked,
  );
  return {
    winner,
    hits,
    unreachable: probes.filter((x) => x.unreachable && x.trust === "trusted").map((x) => x.url),
    denied: probes.some((x) => x.denied && x.trust === "trusted"),
    relayed: winner ? [] : probes.flatMap((x) => (x.relayed ? [x.relayed] : [])),
  };
}

/** Where a relayed question stands at its hub: answered (with the relay result), waiting, or gone. */
type RelayState = { status: string; answer: { ok?: boolean; data?: unknown } | null } | "unreachable" | null;

async function readRelayed(env: Env, ask: RelayedAsk): Promise<RelayState> {
  if (!ask.hub) return localRelayResult(env, ask.id);
  const url = `${ask.hub}/federation/relay/result/${ask.id}`;
  const signed = await signRelayRequest(env, "GET", url);
  if (!signed) return "unreachable";
  try {
    const res = await fedFetch(env, url, {
      headers: { ...signed, "x-relay-ticket": ask.ticket },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) return null; // the hub dropped it
    if (!res.ok) return "unreachable";
    return (await res.json()) as RelayState;
  } catch {
    return "unreachable";
  }
}

/**
 * Collect the answers to questions asked through a hub's relay ({@link askPeers}) and apply the quorum to
 * them with the evidence already in hand. Each answer is the spoke's signed frame, checked exactly as a
 * direct one ({@link acceptAnswer}) against the question as it was asked. A question still waiting stays
 * in `waiting`; one the hub dropped, one older than {@link RELAYED_MAX_AGE_S}, and one the spoke could not
 * answer for a reason worth another try (429, 5xx) come back in `expired`, to be asked again by the next
 * later attempt. A peer no longer trusted lends nothing.
 */
export async function collectRelayed(
  env: Env,
  q: CorroborationQuery,
  asks: RelayedAsk[],
  priorHits: PeerHit[],
  now = nowS(),
): Promise<{ winner: Evidence | null; hits: PeerHit[]; waiting: RelayedAsk[]; expired: string[]; denied: boolean }> {
  const peers = await corroborationPeers(env);
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return { winner: null, hits: priorHits, waiting: asks, expired: [], denied: false };
  }
  const cq = coarsenQuestion(q);
  const waiting: RelayedAsk[] = [];
  const expired: string[] = [];
  const answered: Answered[] = [];
  for (const ask of asks) {
    const peer = peers.find((p) => p.url === ask.url);
    if (peer?.trust !== "trusted") continue; // demoted, blocked or removed since: it lends nothing
    const state = await readRelayed(env, ask);
    const stale = now - ask.askedAt > RELAYED_MAX_AGE_S;
    if (state === null) {
      expired.push(ask.url);
      continue;
    }
    if (state === "unreachable" || state.status !== "answered") {
      if (stale) expired.push(ask.url);
      else waiting.push(ask);
      continue;
    }
    const data = (state.answer?.ok ? state.answer.data : null) as { status?: number; frameB64?: string } | null;
    const status = Number(data?.status ?? 0);
    if (status === 429 || status >= 500) {
      expired.push(ask.url); // the spoke was busy: asked again later
      continue;
    }
    const none: Answered = { url: ask.url, trust: peer.trust, ev: null, denied: false };
    if (status !== 200 || typeof data?.frameB64 !== "string") {
      answered.push(none); // a refusal is an answer
      continue;
    }
    const keys = await keysForOrigin(env, ask.instance);
    if (keys === "blocked" || !keys.length) continue;
    let verdict: Evidence | "no" | null = null;
    try {
      verdict = await acceptAnswer(b64urlToBytes(data.frameB64), {
        instance: ask.instance,
        identity: peerIdentity(registry, peer, keys),
        keys,
        nonce: ask.nonce,
        queryHash: ask.queryHash,
        question: cq,
        revealIgate: flagOn(env.FED_REVEAL_IGATE),
        distBucketM: COARSEN.distBucketM,
        timeBucketSec: COARSEN.timeBucketSec,
        nowS: now,
        askedAt: ask.askedAt,
      });
    } catch {
      /* does not verify */
    }
    answered.push(verdict === "no" ? { ...none, denied: true } : verdict ? { ...none, ev: verdict } : none);
  }
  const { winner, hits } = answered.length
    ? await decide(env, peers, priorHits, answered)
    : { winner: null, hits: priorHits.filter((h) => peers.some((p) => p.url === h.url && p.trust === "trusted")) };
  return { winner, hits, waiting, expired, denied: answered.some((a) => a.denied) };
}
