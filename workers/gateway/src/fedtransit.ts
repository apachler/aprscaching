// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedtransit.ts — per-origin sync: an instance keeps what it mirrored and passes it on, origin by origin. A club
 * hub hears from every spoke; through it each spoke hears from the others as well, and a phone that met one
 * instance carries its records to the next.
 *
 *   GET /federation/sync/summary?for=&bbox=&after=                       what this instance holds, per origin (JSON)
 *   GET /federation/sync/origin?origin=&kind=&since=&limit=&bbox=&for=   one origin's records after a sequence (CBOR)
 *
 * Sequences. Each origin numbers its records per kind, and the number is the record's signed version `v`: a
 * cache's fed_rev and a find's, tombstone's and account move's fed_seq, never below the time in milliseconds, so a
 * database restored from an older backup still numbers above what it handed out before. A mark
 * (`fed_origin_marks`) says "every record of origin Y and this kind up to N is here, or was superseded or
 * deleted". A puller compares a neighbour's summary with its own marks and asks for "origin Y after N"; any
 * neighbour can fill the gap, and switching paths never reads again what is already held.
 *
 * Frames. Every cache, find, tombstone and account move admitted from another instance keeps the frame its origin
 * signed, byte for byte (`fed_transit`), and an origin page serves those frames again, never re-signed: a receiver
 * verifies each against its ORIGIN's key and applies its own trust in that origin, so a neighbour lends a record
 * nothing, neither trust nor a voice in the corroboration quorum. Asked for its own records, an instance serves
 * its native feed. What it passes on of others is a site setting (FED_RESERVE): `trusted` (the default) the records
 * of origins it trusts, `all` those of every origin it has not blocked, `off` none. The summary lists what the
 * policy lets out now, so an origin trusted later, or a wider policy, reaches every puller at its next pass.
 *
 * Marks move only on what is sure. A page names `held`, the sequence up to which its server holds the origin
 * whole, and the puller's mark moves to `min(held, nextCursor)` when the server is the origin itself or a
 * neighbour the puller trusts, and never past the first frame that did not settle (fedapply.ts). Pages from a
 * neighbour nobody vetted still apply but move no mark, so a neighbour that skips a record cannot hide it from the
 * paths that carry it. Beside the mark, a read position per neighbour (`fed_read_positions`) keeps a puller from
 * reading the same pages again. A record that did not settle, or that is kept past the hop limit, is a gap
 * (fedgaps.ts): the mark moves past it, the instance asks its neighbours for that record on its own, and its pages
 * name the gap, so a reader that takes its word asks elsewhere too.
 *
 * Keys. A receiver verifies an origin it has never peered with under the key a neighbour hands on in its summary
 * (the origin's pinned key, its accept set and its rotation records). The first neighbour to name an origin's key
 * pins it in a `transit:<instance>` peer row, `unvetted` and never pulled, so the sysop sees the origin, compares
 * its fingerprint and trusts or blocks it like any peer; afterwards the key moves only along a verified rotation
 * chain. A registry binding wins over any neighbour's word. An origin the receiver later follows directly replaces
 * the handed-on pin, and the records vouched for only by a key the origin does not hold are dropped with it.
 *
 * Loops. A record crosses at most MAX_TRANSIT_HOPS instances; an origin page carries each frame's hop count beside
 * it. Apply is idempotent by global id and version, so a record coming back around a ring of hubs changes nothing.
 * A record never goes back to its origin (`for`).
 *
 * Scope. A local-only cache and imported data never leave their origin: the origin's feeds leave them out,
 * every receiver refuses them (fedapply.ts), and no origin page serves them.
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { nowS } from "./util/time.js";
import { setting } from "./siteconfig.js";
import { encodeFedSyncPage, type FedFrame } from "@aprscaching/shared";
import {
  instanceOf,
  isInstanceId,
  loadKey,
  parseAcceptKeys,
  registryKeyAllowed,
  resolvePeerKeys,
  usableKeys,
  type FedPublicKey,
  type RegistryEntry,
  type RotationRecord,
} from "./federation.js";
import { bboxKey, bboxWhere, bboxWithin, parseBbox, type Bbox } from "./fedregion.js";
import { clientIp, rateLimited } from "./corroborate_privacy.js";
import { buildFedFrames } from "./fedsync.js";
import { forgetGapsStatement, gapsBetween } from "./fedgaps.js";

/** The record kinds synced per origin, in the order a pull applies them: deletes first, keys before moves. */
export const ORIGIN_KINDS = ["tombstone", "account-move", "cache", "find"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];
const isOriginKind = (k: unknown): k is OriginKind => (ORIGIN_KINDS as readonly unknown[]).includes(k);
/** The most instances a record crosses: one passed on at this count is kept, never passed on again. */
export const MAX_TRANSIT_HOPS = 4;
/** Origins learned through neighbours: the peer table never grows past this many `transit:` rows. */
const MAX_TRANSIT_PEERS = 500;
/** Origins one summary page lists. */
const SUMMARY_PAGE = 500;
/** Rotation records kept per origin. */
const MAX_ROTATIONS = 32;
/** Gaps one page names. */
const PAGE_GAPS = 200;
/** Requests per client and minute: summaries, and origin pages. */
const SUMMARY_PER_MIN = 120;
const ORIGIN_PAGES_PER_MIN = 1200;

type ReservePolicy = "trusted" | "all" | "off";

/** Which mirrored records this instance passes on (FED_RESERVE). */
function reservePolicy(env: Env): ReservePolicy {
  const v = setting(env, "FED_RESERVE");
  return v === "all" || v === "off" ? v : "trusted";
}

/** The origins the policy lets out, as SQL over the column `col` holding an origin's instance id. */
function policySql(policy: ReservePolicy, col: string): string {
  const notBlocked = `NOT EXISTS (SELECT 1 FROM fed_peers b WHERE b.instance = ${col} AND b.trust = 'blocked')`;
  if (policy === "all") return notBlocked;
  return `${notBlocked} AND EXISTS (SELECT 1 FROM fed_peers p WHERE p.instance = ${col} AND p.trust = 'trusted')`;
}

/**
 * Keep an admitted frame for passing on. A newer version replaces the frame, and so does the same version that
 * crossed fewer instances to get here, so a record first heard over a long path is passed on once a short one
 * brings it. `via` is the instance that delivered it, `hops` how many instances it has crossed to reach here.
 */
export async function keepForTransit(
  env: Env,
  fb: Uint8Array,
  f: FedFrame,
  kind: string,
  data: Record<string, unknown>,
  via: string,
  hops: number,
): Promise<void> {
  if (!isOriginKind(kind)) return;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  await env.DB.prepare(
    `INSERT INTO fed_transit (gid, origin, kind, v, frame, signer_key, via, hops, target, scope, lat, lon, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(gid) DO UPDATE SET
       v = excluded.v, frame = excluded.frame, signer_key = excluded.signer_key, via = excluded.via,
       hops = excluded.hops, target = excluded.target, scope = excluded.scope, lat = excluded.lat,
       lon = excluded.lon, received_at = excluded.received_at
     WHERE excluded.v > fed_transit.v OR (excluded.v = fed_transit.v AND excluded.hops < fed_transit.hops)`,
  )
    .bind(
      f.record.gid,
      f.record.origin,
      kind,
      f.record.v,
      fb,
      f.signerKey,
      via,
      hops,
      kind === "tombstone" && typeof data.targetId === "string" ? data.targetId : null,
      kind === "cache" && typeof data.fedScope === "string" ? data.fedScope : null,
      kind === "cache" ? num(data.lat) : null,
      kind === "cache" ? num(data.lon) : null,
      nowS(),
    )
    .run();
}

// ---- marks: what this instance holds of each origin ----

/** Does a mark read under `markRegion` hold for `wanted`? '' is the whole feed, which holds for every region. */
function covers(markRegion: string, wanted: string): boolean {
  if (markRegion === "") return true;
  if (wanted === "") return false;
  const outer = parseBbox(markRegion),
    inner = parseBbox(wanted);
  return !!outer && !!inner && bboxWithin(inner, outer);
}

interface MarkRow {
  seq: number;
  region: string;
}

const markRow = (env: Env, origin: string, kind: string) =>
  env.DB.prepare("SELECT seq, region FROM fed_origin_marks WHERE origin = ? AND kind = ?")
    .bind(origin, kind)
    .first<MarkRow>();

/** How far this instance holds `origin`'s records of `kind`, for a reader of `region` ('' = whole): 0 if not. */
export async function markOf(env: Env, origin: string, kind: OriginKind, region = ""): Promise<number> {
  const m = await markRow(env, origin, kind);
  return m && covers(m.region, kind === "cache" ? region : "") ? m.seq : 0;
}

/**
 * The generation of what this instance holds of `origin`: it counts up whenever those marks are forgotten
 * (resetMarks), so a pull that read it before moves no mark after.
 */
export async function markGen(env: Env, origin: string): Promise<number> {
  return (
    (await env.DB.prepare("SELECT gen FROM fed_mark_gen WHERE origin = ?").bind(origin).first<{ gen: number }>())
      ?.gen ?? 0
  );
}

/**
 * Record that every record of `origin` and `kind` up to `seq` is here, read under `region` ('' = whole), as long
 * as the marks of the origin are still of generation `gen`. One statement: a mark that already holds for that
 * region never moves back, whatever runs beside it.
 */
export async function setMark(
  env: Env,
  origin: string,
  kind: OriginKind,
  seq: number,
  gen: number,
  region = "",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fed_origin_marks (origin, kind, seq, region, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE COALESCE((SELECT gen FROM fed_mark_gen WHERE origin = ?), 0) = ?
     ON CONFLICT(origin, kind) DO UPDATE SET seq = excluded.seq, region = excluded.region,
       updated_at = excluded.updated_at
     WHERE excluded.seq > fed_origin_marks.seq
        OR (fed_origin_marks.region != '' AND fed_origin_marks.region != excluded.region)`,
  )
    .bind(origin, kind, seq, kind === "cache" ? region : "", nowS(), origin, gen)
    .run();
}

/**
 * How far this instance has read `via`'s pages of `origin` and `kind`, held or not, and the neighbour's `held` it last
 * read them again from the mark for.
 */
export async function readPosOf(
  env: Env,
  via: string,
  origin: string,
  kind: OriginKind,
  region: string,
): Promise<{ seq: number; replayed: number }> {
  const r = await env.DB.prepare(
    "SELECT seq, replayed FROM fed_read_positions WHERE via = ? AND origin = ? AND kind = ? AND region = ?",
  )
    .bind(via, origin, kind, kind === "cache" ? region : "")
    .first<{ seq: number; replayed: number }>();
  return { seq: r?.seq ?? 0, replayed: r?.replayed ?? 0 };
}

/** Record that `via`'s pages were read again from the mark for its `held` of `replayed`. */
export async function setReplayed(
  env: Env,
  via: string,
  origin: string,
  kind: OriginKind,
  region: string,
  replayed: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE fed_read_positions SET replayed = ? WHERE via = ? AND origin = ? AND kind = ? AND region = ? AND replayed < ?",
  )
    .bind(replayed, via, origin, kind, kind === "cache" ? region : "", replayed)
    .run();
}

/** Move the read position forward (never back), for the same generation of the origin's marks. */
export async function setReadPos(
  env: Env,
  via: string,
  origin: string,
  kind: OriginKind,
  region: string,
  seq: number,
  gen: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fed_read_positions (via, origin, kind, region, seq)
       SELECT ?, ?, ?, ?, ? WHERE COALESCE((SELECT gen FROM fed_mark_gen WHERE origin = ?), 0) = ?
     ON CONFLICT(via, origin, kind, region) DO UPDATE SET seq = excluded.seq
     WHERE excluded.seq > fed_read_positions.seq`,
  )
    .bind(via, origin, kind, kind === "cache" ? region : "", seq, origin, gen)
    .run();
}

/** This instance's own records: the top of each kind's sequence. */
async function nativeHeld(env: Env, kind: OriginKind): Promise<number> {
  return (await env.DB.prepare("SELECT n FROM fed_seq WHERE kind = ?").bind(kind).first<{ n: number }>())?.n ?? 0;
}

/**
 * Raise this instance's own sequences to at least what a trusted neighbour holds of them: a database restored from
 * an older backup, on a box whose clock is behind (a Pi without a real-time clock), then still numbers its next
 * records above what the network holds. Only a trusted neighbour's word counts (fedpull.ts summaryOf).
 */
export async function raiseOwnSequences(env: Env, held: Partial<Record<OriginKind, number>>): Promise<void> {
  for (const kind of ORIGIN_KINDS) {
    const v = held[kind];
    // 2^52 leaves every later number a safe integer
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > 2 ** 52) continue;
    await env.DB.prepare("UPDATE fed_seq SET n = ? WHERE kind = ? AND n < ?").bind(v, kind, v).run();
  }
}

/**
 * How far this instance holds another origin whole, for a reader of `region`: its mark, but for the gaps it knows of
 * (fedgaps.ts), which a page names. `whole` is false when the caches mark was read under a region the reader's does
 * not lie inside, so the records serve but promise nothing. `top` is the highest record it can pass on.
 */
async function heldFor(
  env: Env,
  origin: string,
  kind: OriginKind,
  region: string,
): Promise<{ held: number; whole: boolean; top: number }> {
  const m = await markRow(env, origin, kind);
  const held = m?.seq ?? 0;
  const top =
    (
      await env.DB.prepare("SELECT MAX(v) AS v FROM fed_transit WHERE origin = ? AND kind = ? AND hops < ?")
        .bind(origin, kind, MAX_TRANSIT_HOPS)
        .first<{ v: number | null }>()
    )?.v ?? 0;
  const whole = !m || covers(m.region, kind === "cache" ? region : "");
  // past the records it keeps, a reader is sent on to `held` only where it holds the origin whole for that reader
  return { held, whole, top: Math.max(top, whole ? held : 0) };
}

/**
 * Forget what this instance held of `origin` and how far it read it: its records come again, from whichever path
 * has them. The generation moves on in the same batch, so a pull already under way moves nothing back.
 */
async function resetMarks(env: Env, origin: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fed_mark_gen (origin, gen) VALUES (?, 1) ON CONFLICT(origin) DO UPDATE SET gen = gen + 1`,
    ).bind(origin),
    env.DB.prepare("DELETE FROM fed_origin_marks WHERE origin = ?").bind(origin),
    env.DB.prepare("DELETE FROM fed_read_positions WHERE origin = ?").bind(origin),
    forgetGapsStatement(env, origin),
  ]);
}

// ---- serving ----

/**
 * One origin in a summary: per kind, how far the server holds it whole (`held`, only where the asker's region
 * lies inside what was read) and the highest record it can pass on (`top`); for another instance, the key it
 * verifies under.
 */
export interface SummaryEntry {
  origin: string;
  held: Partial<Record<OriginKind, number>>;
  top: Partial<Record<OriginKind, number>>;
  publicKey?: string;
  publicKeys?: FedPublicKey[];
  rotations?: RotationRecord[];
}

const parseRotations = (s: string | null | undefined): RotationRecord[] => {
  try {
    const v = s ? (JSON.parse(s) as unknown) : [];
    return Array.isArray(v) ? (v as RotationRecord[]).slice(-MAX_ROTATIONS) : [];
  } catch {
    return [];
  }
};

/** The query parameters every origin-sync request shares: the asker and the caches region. */
function syncQuery(req: Request): { u: URL; asker: string; bbox: Bbox | null; badBbox: boolean } {
  const u = new URL(req.url);
  const raw = u.searchParams.get("bbox");
  const bbox = raw != null ? parseBbox(raw) : null;
  return { u, asker: (u.searchParams.get("for") ?? "").toLowerCase(), bbox, badBbox: raw != null && !bbox };
}

const tooMany = (req: Request, env: Env, what: string, max: number) =>
  rateLimited(`${what}:${env.INSTANCE ?? ""}:${clientIp(req, env)}`, Date.now(), max);

/**
 * GET /federation/sync/summary — every origin this instance serves, in instance-id order: itself, and the
 * origins whose records the FED_RESERVE policy passes on, other than the asker (`for`). Each lists, per kind, how
 * far it holds that origin whole for the asker's region (`bbox`) and the highest record it can pass on, and
 * another origin's key as this instance holds it. `asker` tells the asker how far this instance holds the asker's
 * own records. At most SUMMARY_PAGE origins a page; `next` continues it (`after`). 404 while the instance is
 * unsigned.
 */
export async function handleSyncSummary(req: Request, env: Env): Promise<Response> {
  if (!(await loadKey(env))) return json({ error: "instance is unsigned" }, { status: 404 });
  if (tooMany(req, env, "fed-summary", SUMMARY_PER_MIN))
    return json({ error: "too many summary requests: try again in a minute" }, { status: 429 });
  const { u, asker, bbox, badBbox } = syncQuery(req);
  if (badBbox) return json({ error: "bbox must be S,W,N,E in decimal degrees" }, { status: 400 });
  const region = bbox ? bboxKey(bbox) : "";
  const after = u.searchParams.get("after") ?? "";
  const self = instanceOf(req, env);
  const policy = reservePolicy(env);
  const rows =
    policy === "off"
      ? []
      : (
          await env.DB.prepare(
            `SELECT fp.instance, fp.public_key, fp.accept_keys, fp.rotations FROM fed_peers fp
              WHERE fp.trust != 'blocked' AND fp.public_key IS NOT NULL AND fp.instance > ?
                AND fp.instance != ? AND fp.instance != ? AND ${policySql(policy, "fp.instance")}
                AND (EXISTS (SELECT 1 FROM fed_origin_marks m WHERE m.origin = fp.instance)
                     OR EXISTS (SELECT 1 FROM fed_transit t WHERE t.origin = fp.instance))
              ORDER BY fp.instance LIMIT ?`,
          )
            .bind(after, self, asker, SUMMARY_PAGE)
            .all<{ instance: string; public_key: string; accept_keys: string | null; rotations: string | null }>()
        ).results;
  const origins: SummaryEntry[] = [];
  for (const r of rows) {
    const held: SummaryEntry["held"] = {};
    const top: SummaryEntry["top"] = {};
    for (const kind of ORIGIN_KINDS) {
      const h = await heldFor(env, r.instance, kind, region);
      if (h.whole && h.held > 0) held[kind] = h.held;
      if (h.top > 0) top[kind] = h.top;
    }
    origins.push({
      origin: r.instance,
      held,
      top,
      publicKey: r.public_key,
      publicKeys: parseAcceptKeys(r.accept_keys).map((k) => ({ x: k.x, ...(k.until != null && { until: k.until }) })),
      rotations: parseRotations(r.rotations),
    });
  }
  const complete = rows.length < SUMMARY_PAGE;
  // this instance's own entry, in its place in the order
  if (self > after && self !== asker && (complete || self < rows[rows.length - 1]!.instance)) {
    const held: SummaryEntry["held"] = {};
    for (const kind of ORIGIN_KINDS) held[kind] = await nativeHeld(env, kind);
    origins.push({ origin: self, held, top: held });
    origins.sort((a, b) => (a.origin < b.origin ? -1 : 1));
  }
  // what this instance holds of the asker's own records, so an asker restored from an older backup numbers on
  let askerHeld: SummaryEntry["held"] | undefined;
  if (after === "" && isInstanceId(asker) && asker !== self) {
    askerHeld = {};
    for (const kind of ORIGIN_KINDS) {
      const h = await markOf(env, asker, kind);
      if (h > 0) askerHeld[kind] = h;
    }
  }
  return json({
    instance: self,
    origins,
    complete,
    ...(!complete && { next: rows[rows.length - 1]!.instance }),
    ...(askerHeld && Object.keys(askerHeld).length > 0 && { asker: { held: askerHeld } }),
  });
}

interface TransitRow {
  v: number;
  frame: Uint8Array | ArrayBuffer;
  hops: number;
  scope: string | null;
  present: number;
  inside: number;
}

/**
 * GET /federation/sync/origin — one page of `origin`'s records of `kind` after the sequence `since`, as their
 * origin signed them, each with its hop count, ordered by sequence. Asked for its own records, the instance
 * serves its native feed; for another origin, the frames it keeps, while FED_RESERVE lets that origin out. A
 * record never goes back to its origin (`for`) nor past the hop limit, and `bbox` narrows the caches. `nextCursor`
 * is how far the page read; `held` how far the server holds the origin whole. 404 for an origin this instance does
 * not pass on, or while it is unsigned.
 */
export async function handleOriginSync(req: Request, env: Env): Promise<Response> {
  if (!(await loadKey(env))) return json({ error: "instance is unsigned" }, { status: 404 });
  if (tooMany(req, env, "fed-origin", ORIGIN_PAGES_PER_MIN))
    return json({ error: "too many origin pages: try again in a minute" }, { status: 429 });
  const { u, asker, bbox, badBbox } = syncQuery(req);
  const origin = (u.searchParams.get("origin") ?? "").toLowerCase();
  const kind = u.searchParams.get("kind");
  if (!isInstanceId(origin) || !isOriginKind(kind) || badBbox)
    return json({ error: "origin (an instance id), kind and an optional bbox S,W,N,E are required" }, { status: 400 });
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const region = kind === "cache" && bbox ? bbox : null;
  const self = instanceOf(req, env);
  const page = (
    next: number,
    complete: boolean,
    frames: Uint8Array[],
    hops: number[],
    held?: number,
    gaps?: number[],
    hopGaps?: number[],
  ) =>
    new Response(encodeFedSyncPage(self, next, complete, frames, undefined, hops, held, gaps, hopGaps) as BodyInit, {
      headers: { "content-type": "application/cbor" },
    });

  if (origin === self) {
    // the top of the sequence is read before the rows, so a record written meanwhile lies above it
    const top = await nativeHeld(env, kind);
    const built = await buildFedFrames(env, self, kind, since, limit, undefined, region ? { bbox: region } : undefined);
    if (!built) return json({ error: "instance is unsigned" }, { status: 404 });
    const complete = built.frames.length < limit;
    const next = complete ? Math.max(built.nextCursor, top, since) : built.nextCursor;
    return page(
      next,
      complete,
      built.frames,
      built.frames.map(() => 0),
      next,
    );
  }

  const policy = reservePolicy(env);
  const servable =
    origin !== asker &&
    policy !== "off" &&
    !!(await env.DB.prepare(`SELECT 1 AS x FROM (SELECT ? AS o) q WHERE ${policySql(policy, "q.o")}`)
      .bind(origin)
      .first());
  if (!servable) return json({ error: "this instance passes on no records of that origin" }, { status: 404 });
  const { held, whole } = await heldFor(env, origin, kind, region ? bboxKey(region) : "");
  const where = region ? bboxWhere(region) : null;
  const rows = (
    await env.DB.prepare(
      `SELECT t.v, t.frame, t.hops, t.scope,
              CASE t.kind WHEN 'cache' THEN EXISTS (SELECT 1 FROM remote_caches rc WHERE rc.global_id = t.gid)
                          WHEN 'find' THEN EXISTS (SELECT 1 FROM remote_finds rf WHERE rf.global_id = t.gid)
                          ELSE 1 END AS present,
              ${where ? `(${where.sql})` : "1"} AS inside
         FROM fed_transit t WHERE t.origin = ? AND t.kind = ? AND t.v > ? ORDER BY t.v LIMIT ?`,
    )
      .bind(...(where?.params ?? []), origin, kind, since, limit)
      .all<TransitRow>()
  ).results;
  // apply is idempotent, so a record goes back to the neighbour that brought it as well: what it dropped since
  // (a key a hub handed on, replaced) comes back with the rest
  const out = rows.filter(
    (r) => r.hops < MAX_TRANSIT_HOPS && (r.scope ?? "public") !== "local-only" && r.present === 1 && r.inside === 1,
  );
  const complete = rows.length < limit;
  const read = rows.length ? rows[rows.length - 1]!.v : since;
  const next = complete ? Math.max(read, since, whole ? held : 0) : read;
  // the records in this page's range this instance knows it lacks, so a reader that takes its word asks elsewhere;
  // past PAGE_GAPS of them the page promises nothing beyond the last one named
  let pageHeld = whole ? held : undefined;
  let gaps: number[] = [];
  let hopGaps: number[] = [];
  if (pageHeld !== undefined) {
    gaps = await gapsBetween(env, origin, kind, since, next, PAGE_GAPS + 1);
    if (gaps.length > PAGE_GAPS) {
      pageHeld = Math.min(pageHeld, gaps[PAGE_GAPS]! - 1);
      gaps = gaps.slice(0, PAGE_GAPS);
    }
    // the records past the hop limit, apart: no neighbour along this path can fill them, so they raise no alarm
    hopGaps = await gapsBetween(env, origin, kind, since, Math.min(next, pageHeld), limit, true);
  }
  return page(
    next,
    complete,
    out.map((r) => (r.frame instanceof Uint8Array ? r.frame : new Uint8Array(r.frame))),
    out.map((r) => r.hops),
    pageHeld,
    gaps,
    hopGaps,
  );
}

/** Keep a peer's rotation records (from its descriptor or a submission), so a neighbour can hand them on. */
export function rotationsJson(rotations: unknown): string | null {
  return Array.isArray(rotations) && rotations.length ? JSON.stringify(rotations.slice(-MAX_ROTATIONS)) : null;
}

/** Origins one neighbour's summary may name new to this instance per pull, and entries looked at per pull. */
const MAX_LEARNED_PER_PULL = 50;
const MAX_KEY_ENTRIES_PER_PULL = 1000;

/**
 * Pin the keys a neighbour's summary hands on for origins this instance does not know yet, and follow the
 * rotations of those it learned that way. An origin known any other way (pulled, added, submitted, 44Net, the
 * registry's peer list) keeps its own binding, and a blocked one stays blocked: no neighbour can move either.
 * One pull learns at most MAX_LEARNED_PER_PULL new origins, and the table's cap is checked before any key is
 * resolved, so a long summary costs a bounded amount of work.
 */
export async function learnTransitKeys(
  env: Env,
  hub: string,
  entries: readonly SummaryEntry[],
  registry: Map<string, RegistryEntry>,
): Promise<void> {
  const us = env.INSTANCE ?? null;
  let learned = 0;
  let room =
    MAX_TRANSIT_PEERS -
    ((
      await env.DB.prepare("SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'transit'").first<{
        n: number;
      }>()
    )?.n ?? 0);
  for (const b of entries.slice(0, MAX_KEY_ENTRIES_PER_PULL)) {
    if (!isInstanceId(b.origin) || b.origin === us || b.origin === hub) continue;
    if (typeof b.publicKey !== "string" || !b.publicKey) continue;
    const row = await env.DB.prepare(
      `SELECT url, added_via, public_key, accept_keys, trust FROM fed_peers WHERE instance = ?
        ORDER BY trust = 'blocked' DESC, url LIMIT 1`,
    )
      .bind(b.origin)
      .first<{
        url: string;
        added_via: string | null;
        public_key: string | null;
        accept_keys: string | null;
        trust: string;
      }>();
    // an origin only discovery listed takes the hub's key on the same row, which becomes its `transit:` row
    const listed = !!row && row.url.startsWith("discovered:");
    if (row && ((row.added_via !== "transit" && !listed) || row.trust === "blocked")) continue;
    // an origin already pinned to this key: nothing to resolve
    if (row && !listed && row.public_key === b.publicKey) continue;
    // a new origin past the per-pull or the table's cap is left for a later pull, before any key work
    if (!row && (learned >= MAX_LEARNED_PER_PULL || room <= 0)) continue;
    if (!registryKeyAllowed(registry.get(b.origin), b.publicKey)) continue;
    const rotations = Array.isArray(b.rotations) ? b.rotations.slice(-MAX_ROTATIONS) : [];
    const keys = await resolvePeerKeys({
      pinned: row?.public_key ?? null,
      current: b.publicKey,
      published: Array.isArray(b.publicKeys) ? b.publicKeys : [],
      rotations,
      prior: parseAcceptKeys(row?.accept_keys),
      nowS: nowS(),
      graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
    });
    if (!keys.ok || !keys.pin) continue; // a key that moved without a proof keeps the first one
    if (row) {
      await env.DB.prepare(
        `UPDATE fed_peers SET public_key = ?, accept_keys = ?, rotations = ?, url = ?, added_via = 'transit'
          WHERE url = ?`,
      )
        .bind(
          keys.pin,
          JSON.stringify(keys.accept),
          rotationsJson(rotations),
          listed ? `transit:${b.origin}` : row.url,
          row.url,
        )
        .run();
      continue;
    }
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO fed_peers (url, instance, public_key, accept_keys, rotations, trust, added_via, enabled)
       VALUES (?, ?, ?, ?, ?, 'unvetted', 'transit', 0)`,
    )
      .bind(`transit:${b.origin}`, b.origin, keys.pin, JSON.stringify(keys.accept), rotationsJson(rotations))
      .run();
    if (r.meta.changes) {
      learned++;
      room--;
    }
  }
}

/**
 * Drop the records of `instance` that reached here through a neighbour under a key outside `keep`: they were
 * vouched for only by the key a neighbour handed on. The marks for the origin go too, so whatever the origin's own
 * key does cover arrives again. Returns how many records went.
 */
async function dropHubVouched(env: Env, instance: string, keep: ReadonlySet<string>): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT gid, kind, target, signer_key FROM fed_transit WHERE origin = ? AND hops > 1")
      .bind(instance)
      .all<{ gid: string; kind: string; target: string | null; signer_key: string }>()
  ).results.filter((r) => !keep.has(r.signer_key));
  for (const r of rows)
    await env.DB.batch([
      env.DB.prepare("DELETE FROM remote_caches WHERE global_id = ? AND origin = ?").bind(r.gid, instance),
      env.DB.prepare("DELETE FROM remote_finds WHERE global_id = ? AND origin = ?").bind(r.gid, instance),
      env.DB.prepare("DELETE FROM remote_account_moves WHERE global_id = ? AND origin = ?").bind(r.gid, instance),
      ...(r.kind === "tombstone" && r.target
        ? [env.DB.prepare("DELETE FROM remote_tombstones WHERE target_id = ? AND origin = ?").bind(r.target, instance)]
        : []),
      env.DB.prepare("DELETE FROM fed_versions WHERE gid = ?").bind(r.gid),
      env.DB.prepare("DELETE FROM fed_transit WHERE gid = ?").bind(r.gid),
    ]);
  if (rows.length) await resetMarks(env, instance);
  return rows.length;
}

/**
 * A direct binding for `instance` (a pull, an add by address) replaces the key a neighbour handed on: the
 * `transit:` row goes, and so does every record that only the handed-on key vouched for. Call it once the
 * direct keys are verified, before the direct row takes the instance id.
 */
export async function supersedeTransitPeer(env: Env, instance: string, directKeys: readonly string[]): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT url FROM fed_peers WHERE instance = ? AND added_via = 'transit' AND trust != 'blocked'",
  )
    .bind(instance)
    .first<{ url: string }>();
  if (!row) return;
  await dropHubVouched(env, instance, new Set(directKeys));
  await env.DB.prepare("DELETE FROM fed_peers WHERE url = ?").bind(row.url).run();
}

/** A removed `transit:` row takes the records its key vouched for with it. */
export async function forgetTransitPeer(env: Env, instance: string): Promise<void> {
  await dropHubVouched(env, instance, new Set());
}

/** The usable keys of an accept set plus its pin: what a direct binding holds. */
export function heldKeys(pin: string | null, accept: ReturnType<typeof parseAcceptKeys>): string[] {
  return [...new Set([...(pin ? [pin] : []), ...usableKeys(accept, nowS())])];
}
