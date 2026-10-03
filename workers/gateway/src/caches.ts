// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json } from "./app.js";
import {
  CreateCacheRequest,
  UpdateCacheRequest,
  LogRequest,
  type CacheSummary,
  type CacheDetail,
  type CacheLogEntry,
  type MapCache,
} from "@aprscaching/shared";
import {
  verifyFind,
  DEFAULT_POLICY,
  instanceMinTier,
  plausiblePresence,
  type CacheRow,
  type PositionRow,
  type VerifyResult,
  type AppGeo,
} from "./verify.js";
import { provenanceOf, parseAttestedSites } from "./provenance.js";
import { parsePage, keyset, paginate, type Cursor } from "./paging.js";
import { pushAlert } from "./notify.js";
import { sessionIdentity, mayActAsOwner, baseHolder, isWithdrawnCall, displayCall, ingestSecretOk } from "./auth.js";
import { maybeAnnounceFind } from "./announce.js";
import { askPeers, corroboratorIgate } from "./corroborate.js";
import { scheduleRetry, type RetryPlan } from "./corroborate_retry.js";
import { COARSEN } from "./corroborate_privacy.js";
import { emitTombstones } from "./tombstones.js";
import { verifyAuthorship, isKeyRegistered } from "./keys.js";
import { awardFindBadges, awardHideBadge, cacheHealth, favoritesInfo, ratingInfo } from "./community.js";
import { rendezvousFor } from "./rendezvous.js";
import { fieldTime } from "./fieldtime.js";
import { stageCount } from "./stages.js";
import { requireSysop } from "./admin.js";
import { alreadyFound, findPoint, logRefusal } from "./findrules.js";

// ---- D1 row shapes (snake_case) ----
export interface CacheDbRow {
  id: number;
  code: string;
  owner_call: string;
  title: string;
  type: string;
  status: string;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  station_call: string | null;
  source: string;
  external_id: string | null;
  hint: string | null;
  description: string | null;
  min_trust: string | null;
  source_url: string | null;
  source_name: string | null;
  fed_scope: string;
  drive_in: number | null;
  country: string | null;
  tags: string | null;
  rating_policy: string | null;
  rendezvous: number | null;
  created_at: number;
  updated_at: number;
}
export interface LogDbRow {
  id: number;
  cache_id: number;
  logger_call: string;
  ts: number;
  log_type: string;
  verified: number;
  tier: string | null;
  verify_method: string | null;
  distance_m: number | null;
  comment: string | null;
  corroborated_by: string | null;
  corroborated_later_at?: number | null;
  signer_key: string | null;
  received_at?: number | null;
  field_time_rejected?: string | null;
}

export function toSummary(r: CacheDbRow): CacheSummary {
  return {
    id: r.id,
    code: r.code,
    ownerCall: displayCall(r.owner_call),
    title: r.title,
    type: r.type as CacheSummary["type"],
    status: r.status as CacheSummary["status"],
    difficulty: r.difficulty,
    terrain: r.terrain,
    lat: r.lat,
    lon: r.lon,
    stationCall: r.station_call,
    source: r.source,
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    minTrust: (r.min_trust as "A" | "B" | null) ?? null,
    fedScope: (r.fed_scope as CacheSummary["fedScope"]) ?? "public",
    driveIn: !!r.drive_in,
    country: r.country ?? null,
    tags: splitTags(r.tags),
  };
}

/** Stored tags are a comma-joined string; expose as an array (empty when null). */
function splitTags(csv: string | null): string[] {
  return csv
    ? csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
/** Normalise request tags → a comma-joined, deduped, lowercased string (or null). */
function joinTags(tags: string[] | undefined): string | null {
  if (!tags?.length) return null;
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return seen.size ? [...seen].slice(0, 12).join(",") : null;
}
export function toLogEntry(r: LogDbRow): CacheLogEntry {
  return {
    id: r.id,
    cacheId: r.cache_id,
    loggerCall: displayCall(r.logger_call),
    ts: r.ts,
    logType: r.log_type as CacheLogEntry["logType"],
    verified: r.verified === 1,
    tier: (r.tier as CacheLogEntry["tier"]) ?? null,
    verifyMethod: r.verify_method,
    distanceM: r.distance_m,
    comment: r.comment,
    corroboratedBy: r.corroborated_by,
    corroboratedLaterAt: r.corroborated_later_at ?? null,
    signerKey: r.signer_key,
    receivedAt: r.received_at ?? null,
    fieldTimeRejected: r.field_time_rejected ?? null,
  };
}

function ingestOk(req: Request, env: Env): boolean {
  return ingestSecretOk(req, env);
}

/**
 * The AUTHORISED acting callsign for a write (hide / log): a signed-in passkey session wins;
 * otherwise the body callsign IS allowed only when the request carries the ingest secret — i.e.
 * the trusted backend / APRS-originated path (an RF-heard find attributed to its callsign). A bare
 * web request with neither is rejected (null → 401). This is what gates web logging behind sign-in
 * without breaking the over-APRS logging path.
 */
export async function actor(req: Request, env: Env, fallback?: string): Promise<string | null> {
  const s = (await sessionIdentity(req, env))?.callsign;
  // the withdrawn marker names an erased identity, never someone acting now
  if (s) return isWithdrawnCall(s) ? null : s.toUpperCase();
  if (ingestOk(req, env) && fallback && !isWithdrawnCall(fallback)) return fallback.toUpperCase();
  return null;
}

export interface RemoteCacheRow {
  global_id: string;
  origin: string;
  code: string;
  owner_call: string;
  title: string;
  type: string;
  status: string;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  station_call: string | null;
  source: string;
  external_id: string | null;
  min_trust: string | null;
  origin_trust: string; // joined from fed_peers: 'trusted' | 'unvetted' (blocked is filtered out)
}

export function nativeMapCache(r: CacheDbRow, instance: string): MapCache {
  return {
    globalId: `${instance}:cache:${r.id}`,
    id: r.id,
    code: r.code,
    ownerCall: displayCall(r.owner_call),
    title: r.title,
    type: r.type as MapCache["type"],
    status: r.status as MapCache["status"],
    difficulty: r.difficulty,
    terrain: r.terrain,
    lat: r.lat,
    lon: r.lon,
    origin: instance,
    mirrored: false,
    originTrust: "native",
    source: r.source,
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    country: r.country ?? null,
    tags: splitTags(r.tags),
  };
}
export function remoteMapCache(r: RemoteCacheRow): MapCache {
  return {
    globalId: r.global_id,
    id: null,
    code: r.code,
    ownerCall: r.owner_call,
    title: r.title,
    type: r.type as MapCache["type"],
    status: r.status as MapCache["status"],
    difficulty: r.difficulty,
    terrain: r.terrain,
    lat: r.lat,
    lon: r.lon,
    origin: r.origin,
    mirrored: true,
    originTrust: r.origin_trust === "trusted" ? "trusted" : "unvetted",
    source: r.source,
    sourceName: null,
    sourceUrl: null,
    country: null,
    tags: [],
  };
}

// ---------------------------------------------------------------- list (map layer)
// Aggregates native caches + caches mirrored from federation peers, each tagged with its origin's
// trust. Trust policy: native always shown; `trusted`-origin mirrors shown by default; `unvetted`
// (auto-discovered) hidden unless `?includeUnvetted=1`; `blocked` never surfaced. The trust is a
// read-time join to fed_peers, so promoting/blocking a peer takes effect immediately, no re-mirror.
/**
 * The listing filter for unlisted caches: an `unlisted` cache stays off maps, search and feeds, reached only
 * by its link or code, except in its own owner's listings (`owner_call` is a base call or one of its SSIDs).
 */
export async function listedOrOwn(
  req: Request,
  env: Env,
  col = "owner_call",
): Promise<{ sql: string; binds: string[] }> {
  const me = await sessionIdentity(req, env);
  if (!me) return { sql: "fed_scope != 'unlisted'", binds: [] };
  return {
    sql: `(fed_scope != 'unlisted' OR EXISTS (SELECT 1 FROM account_callsigns ac
            WHERE ac.account_id = ? AND (${col} = ac.callsign OR ${col} LIKE ac.callsign || '-%')))`,
    binds: [me.accountId],
  };
}

/**
 * A living cache at its station's last heard position, with when that was; any other cache, or one whose station
 * is unheard, as stored.
 */
async function livingAt(env: Env, row: CacheDbRow): Promise<{ row: CacheDbRow; heardAt: number | null }> {
  if (row.type !== "aprs_living" || !row.station_call) return { row, heardAt: null };
  const st = await env.DB.prepare("SELECT lat, lon, last_seen FROM stations WHERE callsign = ?")
    .bind(row.station_call.toUpperCase())
    .first<{ lat: number | null; lon: number | null; last_seen: number | null }>();
  return st?.lat != null && st.lon != null
    ? { row: { ...row, lat: st.lat, lon: st.lon }, heardAt: st.last_seen ?? null }
    : { row, heardAt: null };
}

export async function handleCachesInBBox(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const [minLon, minLat, maxLon, maxLat] = (u.searchParams.get("bbox") ?? "-180,-90,180,90").split(",").map(Number);
  if ([minLon, minLat, maxLon, maxLat].some(Number.isNaN)) return json({ error: "bad bbox" }, { status: 400 });
  const instance = env.INSTANCE ?? u.host;
  const includeUnvetted = u.searchParams.get("includeUnvetted") === "1" || u.searchParams.get("network") === "all";

  const listed = await listedOrOwn(req, env);
  const native = await env.DB.prepare(
    `SELECT * FROM caches
     WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status != 'archived' AND type != 'aprs_living'
       AND ${listed.sql} LIMIT 1000`,
  )
    .bind(minLat, maxLat, minLon, maxLon, ...listed.binds)
    .all<CacheDbRow>();
  // a living cache is where its station was last heard, and where it was hidden until the station is heard
  const living = await env.DB.prepare(
    `SELECT c.*, s.lat AS st_lat, s.lon AS st_lon FROM caches c
       LEFT JOIN stations s ON s.callsign = UPPER(c.station_call)
      WHERE c.type = 'aprs_living' AND c.status != 'archived' AND ${listed.sql}
        AND COALESCE(s.lat, c.lat) BETWEEN ? AND ? AND COALESCE(s.lon, c.lon) BETWEEN ? AND ? LIMIT 500`,
  )
    .bind(...listed.binds, minLat, maxLat, minLon, maxLon)
    .all<CacheDbRow & { st_lat: number | null; st_lon: number | null }>();
  // origin trust defaults to 'unvetted' when the origin peer is unknown (e.g. removed) — hidden by default.
  const remote = await env.DB.prepare(
    `SELECT rc.*, COALESCE(fp.trust, 'unvetted') AS origin_trust
       FROM remote_caches rc
       LEFT JOIN fed_peers fp ON fp.instance = rc.origin
      WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived' AND rc.fed_scope != 'unlisted'
        AND COALESCE(fp.trust, 'unvetted') != 'blocked'
        AND (? = 1 OR COALESCE(fp.trust, 'unvetted') = 'trusted')
      LIMIT 1000`,
  )
    .bind(minLat, maxLat, minLon, maxLon, includeUnvetted ? 1 : 0)
    .all<RemoteCacheRow>();

  const caches: MapCache[] = [
    ...native.results.map((r) => nativeMapCache(r, instance)),
    ...living.results.map(({ st_lat, st_lon, ...r }) =>
      nativeMapCache(st_lat != null && st_lon != null ? { ...r, lat: st_lat, lon: st_lon } : r, instance),
    ),
    ...remote.results.map(remoteMapCache),
  ];
  return json({ caches, includeUnvetted });
}

// ---------------------------------------------------------------- detail + logbook
const LOGBOOK_PAGE = 50;

/** Fetch one keyset page of a cache's logbook, newest first. */
async function logbookPage(env: Env, id: number, cursor: Cursor | null, limit: number) {
  const ks = keyset(cursor, "ts", "id");
  const rows = (
    await env.DB.prepare(`SELECT * FROM cache_logs WHERE cache_id = ?${ks.sql} ORDER BY ts DESC, id DESC LIMIT ?`)
      .bind(id, ...ks.binds, limit + 1)
      .all<LogDbRow>()
  ).results;
  return paginate(rows, limit, (r) => ({ primary: r.ts, id: r.id }));
}

export async function handleCacheDetail(req: Request, env: Env, id: number): Promise<Response> {
  const stored = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  if (!stored) return json({ error: "no such cache" }, { status: 404 });
  const { row, heardAt: stationHeardAt } = await livingAt(env, stored);
  const logs = await logbookPage(env, id, null, LOGBOOK_PAGE);
  const finds = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id = ? AND log_type = 'found' AND verified = 1",
  )
    .bind(id)
    .first<{ n: number }>();
  // finds-over-time: monthly verified-find counts (last 12 months), oldest→newest for a sparkline
  const series = (
    await env.DB.prepare(
      `SELECT strftime('%Y-%m', ts, 'unixepoch') AS month, COUNT(*) AS n FROM cache_logs
       WHERE cache_id = ? AND log_type = 'found' AND verified = 1 GROUP BY month ORDER BY month DESC LIMIT 12`,
    )
      .bind(id)
      .all<{ month: string; n: number }>()
  ).results.reverse();
  // the caller's own favourite and rating: `?callsign=` names someone else only with the ingest secret
  const who = await actor(req, env, new URL(req.url).searchParams.get("callsign") ?? undefined);
  const health = await cacheHealth(env, id);
  const fav = await favoritesInfo(env, id, who);
  const rating = await ratingInfo(env, id, (row.rating_policy ?? "finders") as "finders" | "all" | "off", who);
  // a meeting's time and place are the hider's: anyone else sees whom the cache met and on which day
  const isOwner = await mayActAsOwner(req, env, row.owner_call);
  const met = row.rendezvous ? await rendezvousFor(env, id) : [];
  const rendezvous =
    met.length && !isOwner
      ? met.map((r) => ({ ...r, ts: r.ts - (r.ts % 86_400) + 43_200, lat: null, lon: null, day: true }))
      : met;
  const stages = await stageCount(env, id);
  const detail: CacheDetail = {
    ...toSummary(row),
    // the minimum a find meets: the cache's own, else the instance's
    minTrust: (row.min_trust as "A" | "B" | null) ?? instanceMinTier(env),
    hint: row.hint,
    description: row.description,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finds: finds?.n ?? 0,
    findsByMonth: series,
    logs: logs.items.map(toLogEntry),
    logsCursor: logs.nextCursor,
    logsHasMore: logs.hasMore,
    favorites: fav.favorites,
    favorited: fav.favorited,
    needsMaintenance: health.needsMaintenance,
    dnfStreak: health.dnfStreak,
    lastFound: health.lastFound,
    rating,
    rendezvous,
    stageCount: stages,
    ...(row.type === "aprs_living" && { stationHeardAt }),
    ...(isOwner && {
      own: { minTrust: (row.min_trust as "A" | "B" | null) ?? null, rendezvous: !!row.rendezvous },
    }),
  };
  return json({ cache: detail });
}

/** GET /api/caches/:id/logs — paginated logbook ("Load more" past the first page in the detail). */
export async function handleCacheLogs(req: Request, env: Env, id: number): Promise<Response> {
  const pg = parsePage(new URL(req.url), LOGBOOK_PAGE, 200);
  const page = await logbookPage(env, id, pg.cursor, pg.limit);
  return json({ logs: page.items.map(toLogEntry), nextCursor: page.nextCursor, hasMore: page.hasMore });
}

/**
 * A living cache follows a station its hider operates: the station must be one of the signed-in account's own
 * (Settings → My stations), so nobody turns someone else's beacon into a cache to be chased. The ingest plane,
 * a trusted machine of the instance, is not asked.
 */
async function livingStationRefusal(
  req: Request,
  env: Env,
  type: string,
  stationCall: string | null | undefined,
): Promise<string | null> {
  if (type !== "aprs_living") return null;
  const cs = stationCall?.trim().toUpperCase();
  if (!cs) return "a living cache follows a station: pick one of your stations";
  if (ingestOk(req, env)) return null;
  const me = await sessionIdentity(req, env);
  if (!me) return "sign in to hide a living cache";
  const own = await env.DB.prepare("SELECT 1 AS x FROM account_stations WHERE account_id = ? AND callsign = ?")
    .bind(me.accountId, cs)
    .first();
  return own ? null : `${cs} is not one of your stations: add it under Settings → My stations first`;
}

/**
 * Heritage places (SOTA summits, POTA parks, WWFF reserves, bunkers, castles) come from the sysop's import of the
 * programmes' own lists, so their badges stand for the real place. A player hides a cache there as a traditional
 * one; only the sysop or the instance's own import creates or retypes one.
 */
const HERITAGE_TYPES = new Set(["sota", "pota", "wwff", "bunker", "castle"]);
async function heritageRefusal(req: Request, env: Env, type: string): Promise<string | null> {
  if (!HERITAGE_TYPES.has(type) || ingestOk(req, env) || !(await requireSysop(req, env))) return null;
  return "heritage places come from the sysop's import: hide a cache at one as a traditional cache";
}

// ---------------------------------------------------------------- create ("hide a cache")
/** The form of the codes the instance mints, `AC-` and the cache id. */
const MINTED_CODE = /^AC-\d+$/i;

export async function handleCreateCache(req: Request, env: Env): Promise<Response> {
  const parsed = CreateCacheRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;

  const owner = await actor(req, env, b.ownerCall);
  if (!owner) return json({ error: "owner callsign required (sign in or pass ownerCall)" }, { status: 401 });
  const notOwn = await livingStationRefusal(req, env, b.type, b.stationCall);
  if (notOwn) return json({ error: notOwn }, { status: 403 });
  const heritage = await heritageRefusal(req, env, b.type);
  if (heritage) return json({ error: heritage }, { status: 403 });
  if (b.code) {
    // An explicit code is for imports by the instance itself. A player who picked one could take a code the
    // instance mints later, or one that reads like another cache's.
    if (!ingestOk(req, env) && (await requireSysop(req, env)))
      return json({ error: "only the sysop can choose a cache code" }, { status: 403 });
    if (MINTED_CODE.test(b.code)) return json({ error: "AC- codes are minted by the instance" }, { status: 400 });
  }

  const now = nowS();
  const tmpCode = `__minting__${crypto.randomUUID()}`;
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO caches
         (code, owner_call, title, type, status, difficulty, terrain, lat, lon,
          station_call, source, hint, description, min_trust, fed_scope,
          drive_in, country, tags, rating_policy, rendezvous, created_at, updated_at)
       VALUES (?,?,?,?, 'active', ?,?,?,?, ?, 'native', ?,?,?,?, ?,?,?,?,?, ?,?)`,
    )
      .bind(
        tmpCode,
        owner,
        b.title,
        b.type,
        b.difficulty,
        b.terrain,
        b.lat,
        b.lon,
        b.stationCall ?? null,
        b.hint ?? null,
        b.description ?? null,
        b.minTrust ?? null,
        b.fedScope,
        b.driveIn ? 1 : 0,
        b.country ?? null,
        joinTags(b.tags),
        b.ratingPolicy ?? "finders",
        b.rendezvous ? 1 : 0,
        now,
        now,
      )
      .run();
    const id = Number(ins.meta.last_row_id);
    const code = b.code ?? `AC-${String(id).padStart(4, "0")}`;
    await env.DB.prepare("UPDATE caches SET code = ? WHERE id = ?").bind(code, id).run();
    const row = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
    await awardHideBadge(env, owner); // hider badges
    return json({ cache: toSummary(row!) }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/UNIQUE/i.test(msg)) return json({ error: "code already exists" }, { status: 409 });
    return json({ error: "create failed", detail: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------- update (owner CRUD)
export async function handleUpdateCache(req: Request, env: Env, id: number): Promise<Response> {
  const parsed = UpdateCacheRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;

  const existing = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  if (!existing) return json({ error: "no such cache" }, { status: 404 });

  // an erased owner's cache stays archived: nobody inherits it through the withdrawn marker
  if (isWithdrawnCall(existing.owner_call))
    return json({ error: "this cache's owner has withdrawn — it cannot be edited" }, { status: 403 });
  if (!(await mayActAsOwner(req, env, existing.owner_call, b.ownerCall)))
    return json({ error: "only the owner may edit this cache" }, { status: 403 });

  // merge: undefined keeps existing
  const m = {
    title: b.title ?? existing.title,
    type: b.type ?? existing.type,
    status: b.status ?? existing.status,
    difficulty: b.difficulty ?? existing.difficulty,
    terrain: b.terrain ?? existing.terrain,
    lat: b.lat ?? existing.lat,
    lon: b.lon ?? existing.lon,
    station_call: b.stationCall ?? existing.station_call,
    hint: b.hint ?? existing.hint,
    description: b.description ?? existing.description,
    min_trust: b.minTrust === undefined ? existing.min_trust : b.minTrust, // null: back to the instance's minimum
    fed_scope: b.fedScope ?? existing.fed_scope,
    drive_in: b.driveIn === undefined ? existing.drive_in : b.driveIn ? 1 : 0,
    country: b.country ?? existing.country,
    tags: b.tags === undefined ? existing.tags : joinTags(b.tags),
    rating_policy: b.ratingPolicy ?? existing.rating_policy ?? "finders",
    rendezvous: b.rendezvous === undefined ? existing.rendezvous : b.rendezvous ? 1 : 0,
  };
  if (m.type === "aprs_living" && (m.type !== existing.type || m.station_call !== existing.station_call)) {
    const notOwn = await livingStationRefusal(req, env, m.type, m.station_call);
    if (notOwn) return json({ error: notOwn }, { status: 403 });
  }
  if (m.type !== existing.type) {
    const heritage = await heritageRefusal(req, env, m.type);
    if (heritage) return json({ error: heritage }, { status: 403 });
  }
  const now = nowS();
  await env.DB.prepare(
    `UPDATE caches SET title=?, type=?, status=?, difficulty=?, terrain=?, lat=?, lon=?,
       station_call=?, hint=?, description=?, min_trust=?, fed_scope=?,
       drive_in=?, country=?, tags=?, rating_policy=?, rendezvous=?, updated_at=? WHERE id=?`,
  )
    .bind(
      m.title,
      m.type,
      m.status,
      m.difficulty,
      m.terrain,
      m.lat,
      m.lon,
      m.station_call,
      m.hint,
      m.description,
      m.min_trust,
      m.fed_scope,
      m.drive_in,
      m.country,
      m.tags,
      m.rating_policy,
      m.rendezvous,
      now,
      id,
    )
    .run();
  // turning a cache local-only must RETRACT copies already mirrored on peers — emit a cache
  // tombstone so they purge it (a public→unlisted change re-propagates the redacted version via the
  // bumped updated_at instead). Re-widening a local-only cache later won't un-suppress it on peers.
  if (m.fed_scope === "local-only" && existing.fed_scope !== "local-only") {
    const instance = env.INSTANCE ?? new URL(req.url).host;
    await emitTombstones(env, instance, [{ kind: "cache", targetId: `${instance}:cache:${id}` }]);
  }
  const row = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheDbRow>();
  return json({ cache: toSummary(row!) });
}

// ---------------------------------------------------------------- log (found/DNF/note/…)
export async function handleLog(req: Request, env: Env, cacheId: number): Promise<Response> {
  const parsed = LogRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error?.issues }, { status: 400 });
  const { comment, appGeo, logType } = parsed.data;

  // Logging requires a signed-in session (web) OR the ingest secret (APRS/RF-originated finds,
  // attributed to the heard callsign and authorised by the trusted backend, not a cookie).
  const sessionCall = (await sessionIdentity(req, env))?.callsign ?? null;
  let loggerCall: string;
  if (sessionCall) {
    loggerCall = sessionCall.toUpperCase();
    const claimed = parsed.data.loggerCall?.toUpperCase();
    if (claimed && baseCall(claimed) === baseCall(loggerCall)) loggerCall = claimed; // operate as an SSID of your own call
  } else if (ingestOk(req, env) && parsed.data.loggerCall) {
    loggerCall = parsed.data.loggerCall.toUpperCase();
  } else {
    return json({ error: "sign in to log a find" }, { status: 401 });
  }
  const accountVerified = sessionCall != null; // session => passkey-bound account

  const cache = await env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(cacheId).first<
    CacheRow & {
      code: string;
      title: string;
      created_at: number;
      status: string;
      owner_call: string;
      source: string | null;
    }
  >();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });
  const sessionAccount = sessionCall ? ((await sessionIdentity(req, env))?.accountId ?? null) : null;
  // an archived or disabled cache takes no find or did-not-find, and an owner does not find their own cache
  const refused = await logRefusal(env, cache, loggerCall, logType, sessionAccount);
  if (refused) return json({ error: refused }, { status: 409 });

  const now = nowS();

  // Per-callsign authorship: if the logger signed the log with their device key, verify it
  // (signature valid AND key registered to the callsign) and persist it as portable provenance.
  let signerKey: string | null = null,
    authorSig: string | null = null,
    signedAt: number | null = null;
  if (parsed.data.author) {
    const a = parsed.data.author;
    const instance = env.INSTANCE ?? new URL(req.url).host;
    const okSig = await verifyAuthorship({
      cache: cache.code,
      instance,
      logger: loggerCall,
      logType,
      at: a.signedAt,
      authorKey: a.authorKey,
      authorSig: a.authorSig,
    });
    if (!okSig) return json({ error: "invalid author signature" }, { status: 400 });
    if (!(await isKeyRegistered(env, loggerCall, a.authorKey)))
      return json({ error: "author key not registered to callsign" }, { status: 400 });
    signerKey = a.authorKey;
    authorSig = a.authorSig;
    signedAt = a.signedAt;
  }
  // The find time: the signed field time within its bounds, else now (fieldtime.ts). A find queued offline
  // is scored, stored and federated at the moment it was made.
  const ft = await fieldTime(env, {
    now,
    loggerCall,
    cacheCreatedAt: cache.created_at,
    signed: signerKey && signedAt != null ? { at: signedAt, key: signerKey } : null,
    offline: parsed.data.offline,
  });
  const foundAt = ft.foundAt;

  // a found is idempotent per (cache, logger). Checked AFTER author-signature
  // verification (a tampered replay still 400s), BEFORE re-running verify + insert + owner-alert +
  // announce + gossip. A racing pair that both miss this is caught by the INSERT OR IGNORE below.
  if (logType === "found") {
    const prior = await env.DB.prepare(
      "SELECT verified, tier, verify_method FROM cache_logs WHERE cache_id=? AND logger_call=? AND log_type='found' LIMIT 1",
    )
      .bind(cacheId, loggerCall)
      .first<{ verified: number; tier: string | null; verify_method: string | null }>();
    if (prior)
      return json({
        logged: true,
        logType: "found",
        duplicate: true,
        accountVerified,
        signerKey,
        verified: prior.verified === 1,
        tier: prior.tier,
        method: prior.verify_method,
      });
    // a find counts once per person: another SSID of the same call, or another call on the account, holds it
    const byPerson = await alreadyFound(env, cacheId, loggerCall, sessionAccount);
    if (byPerson)
      return json(
        { error: `${cache.code} is already logged as found by ${byPerson}`, foundBy: byPerson },
        { status: 409 },
      );
  }

  // Only `found` logs are presence-verified; DNF/note/maintenance are plain records.
  if (logType !== "found") {
    await env.DB.prepare(
      `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, comment, signer_key, author_sig, signed_at, received_at, field_time_rejected)
       VALUES (?,?,?,?, 0, NULL, 'manual', ?,?,?,?,?,?)`,
    )
      .bind(cacheId, loggerCall, foundAt, logType, comment ?? null, signerKey, authorSig, signedAt, now, ft.rejected)
      .run();
    return json({
      logged: true,
      logType,
      accountVerified,
      verified: false,
      signerKey,
      foundAt,
      fieldTimeRejected: ft.rejected,
    });
  }

  const score = await scoreFind(env, cache, loggerCall, foundAt, appGeo);
  const committed = await commitFind(env, cache, loggerCall, foundAt, comment ?? null, score, {
    signerKey,
    authorSig,
    signedAt,
    fieldTimeRejected: ft.rejected,
  });
  const { result, corroboratedBy } = score;
  if (committed.duplicate)
    return json({
      logged: true,
      logType: "found",
      duplicate: true,
      accountVerified,
      verified: result.verified,
      tier: result.tier,
      method: result.method,
    });
  return json({
    logged: true,
    logType,
    accountVerified,
    announced: committed.announced,
    corroboratedBy,
    signerKey,
    foundAt,
    fieldTimeRejected: ft.rejected,
    ...result,
  });
}

/** A found log's verification outcome, computed before anything is written. */
export interface FindScore {
  result: VerifyResult;
  /** Peer instance whose RF evidence lifted the find to Tier A, when local evidence did not. */
  corroboratedBy: string | null;
  /** IGate credited on the corroborator board for a Tier-A find. */
  corrIgate: string | null;
  /** Set when the find missed Tier A only because trusted peers could not be reached: ask them later. */
  retry?: RetryPlan;
}

/**
 * Score a found log for `loggerCall` at time `at`: the logger's positions in the verification window
 * before `at`, stamped with first-party attestation, the Tier-A independence set, and — when local
 * evidence falls short of Tier A — federation peers. Writes nothing, so a radio command can be scored
 * when its message is heard and committed later.
 */
export async function scoreFind(
  env: Env,
  listed: CacheRow & { code: string },
  loggerCall: string,
  at: number,
  appGeo?: AppGeo,
): Promise<FindScore> {
  const cache = await findPoint(env, listed);
  const since = at - DEFAULT_POLICY.windowSec;
  const lp = await env.DB.prepare(
    // `ts <= at+60` — without the upper bound a future-dated fix sits inside the window forever
    "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? AND source != 'service' ORDER BY ts DESC LIMIT 500",
  )
    .bind(loggerCall, since, at + 60)
    .all<PositionRow>();

  let cacheStationPositions: PositionRow[] | undefined;
  if (cache.type === "aprs_living" && cache.station_call) {
    const cs = await env.DB.prepare(
      "SELECT * FROM positions WHERE callsign = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 500",
    )
      .bind(cache.station_call, since, at + 60)
      .all<PositionRow>();
    cacheStationPositions = cs.results;
  }

  // Provenance seam: stamp each fix with firstPartyAttested at the boundary so the verify
  // engine branches on attestation alone, never on transport. FIRST_PARTY_SITES narrows attestation.
  const attestedSites = parseAttestedSites((env as { FIRST_PARTY_SITES?: string }).FIRST_PARTY_SITES);
  const attest = (rows: PositionRow[]): PositionRow[] =>
    rows.map((p) => ({ ...p, firstPartyAttested: provenanceOf(p, attestedSites).firstPartyAttested }));

  // Tier-A independence — every base callsign the logger controls (their own call,
  // all base calls held by their account, their registered stations). A beacon gated by any of
  // these is self-gated and can never corroborate the logger's own find.
  const loggerOwnIgates = new Set<string>([baseCall(loggerCall)]);
  const acct = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ?")
    .bind(baseCall(loggerCall))
    .first<{ account_id: string }>();
  if (acct) {
    const held = await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id = ?")
      .bind(acct.account_id)
      .all<{ callsign: string }>();
    for (const r of held.results) loggerOwnIgates.add(baseCall(r.callsign));
    const stations = await env.DB.prepare("SELECT callsign FROM account_stations WHERE account_id = ?")
      .bind(acct.account_id)
      .all<{ callsign: string }>();
    for (const r of stations.results) loggerOwnIgates.add(baseCall(r.callsign));
  }

  const result = verifyFind(
    cache,
    appGeo,
    {
      loggerPositions: attest(lp.results),
      cacheStationPositions: cacheStationPositions ? attest(cacheStationPositions) : undefined,
      loggerOwnIgates,
      now: at, // app-reading freshness is judged against log time
    },
    { ...DEFAULT_POLICY, minTier: instanceMinTier(env) },
  );

  // The gating IGate of a locally verified Tier-A find (its matched RF position) — credited on the
  // corroborator board. A peer-corroborated find's IGate is captured below (cross-instance credit).
  let peerIgate: string | null = null;
  const matchedIgate =
    result.matchedPositionId != null
      ? (lp.results.find((p) => p.id === result.matchedPositionId)?.igate_call ?? null)
      : null;

  // if we couldn't reach Tier A locally, ask peers whether the logger was independently heard on RF
  // near the cache (cross-instance corroboration), excluding every IGate the logger controls. A living
  // cache is asked about where its station last was, not where it started. A hit upgrades the find
  // to Tier A only if the logger's own local track could have been there.
  let corroboratedBy: string | null = null;
  let retry: RetryPlan | undefined;
  const lastStation = cacheStationPositions?.find((p) => p.ts <= at + 60);
  const point =
    cache.type === "aprs_living"
      ? lastStation
        ? { lat: lastStation.lat, lon: lastStation.lon }
        : null
      : cache.lat != null && cache.lon != null
        ? { lat: cache.lat, lon: cache.lon }
        : null;
  if (result.tier !== "A" && point) {
    const query = {
      callsign: loggerCall,
      lat: point.lat,
      lon: point.lon,
      radiusM: DEFAULT_POLICY.radiusM,
      since,
      until: at,
      excludeIgates: [...loggerOwnIgates],
    };
    const asked = await askPeers(env, query);
    const ev = asked.winner;
    // Short of quorum only because trusted peers were not reached, and no trusted peer said no: the
    // same question goes to those peers again later (corroborate_retry.ts).
    if (!ev && !asked.denied && asked.unreachable.length)
      retry = { query, unreachable: asked.unreachable, hits: asked.hits };
    if (ev && plausiblePresence({ ...point, ts: ev.ts }, lp.results, DEFAULT_POLICY, COARSEN.timeBucketSec)) {
      corroboratedBy = ev.instance;
      result.tier = "A";
      result.method = "aprs_rf_peer";
      result.verified = true; // A satisfies any cache min_trust
      result.distanceM = ev.distanceM;
      result.matchedPositionId = undefined;
      result.reason = undefined;
      peerIgate = ev.igateCall ?? null; // present only when both instances opted into FED_REVEAL_IGATE
    }
  }

  // Credit the corroborating IGate (local or cross-instance) on this verified find.
  const corrIgate =
    result.verified && result.tier === "A"
      ? corroboratorIgate({ method: result.method, matchedIgate, peerIgate, loggerCall })
      : null;
  return { result, corroboratedBy, corrIgate, ...(retry && result.tier !== "A" && { retry }) };
}

/**
 * Write a scored found log and run its consequences: find badges, the cache owner's alert, the
 * corroborating IGate operator's alert, and the opt-in APRS-IS announce. A second found for the same
 * (cache, logger) is reported as a duplicate and triggers nothing.
 */
export async function commitFind(
  env: Env,
  cache: CacheRow & { id: number; code: string; title: string },
  loggerCall: string,
  at: number,
  comment: string | null,
  score: FindScore,
  author: {
    signerKey: string | null;
    authorSig: string | null;
    signedAt: number | null;
    fieldTimeRejected?: string | null;
  } = {
    signerKey: null,
    authorSig: null,
    signedAt: null,
  },
): Promise<{ duplicate: boolean; logId?: number; announced?: unknown }> {
  const { result, corroboratedBy, corrIgate } = score;
  const cacheId = cache.id;
  // INSERT OR IGNORE against the partial unique index on (cache, logger) founds. If a concurrent
  // found for the same pair beat us here, changes()==0 → don't fire the alert/announce/gossip twice.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, matched_position_id, distance_m, comment, corroborated_by, corroborator_igate, signer_key, author_sig, signed_at, received_at, field_time_rejected)
     VALUES (?,?,?, 'found', ?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      cacheId,
      loggerCall,
      at,
      result.verified ? 1 : 0,
      result.tier,
      result.method,
      result.matchedPositionId ?? null,
      result.distanceM ?? null,
      comment,
      corroboratedBy,
      corrIgate,
      author.signerKey,
      author.authorSig,
      author.signedAt,
      nowS(),
      author.fieldTimeRejected ?? null,
    )
    .run();
  if ((ins.meta?.changes ?? 1) === 0) return { duplicate: true };
  const logId = Number(ins.meta?.last_row_id) || undefined;
  const now = nowS();
  if (score.retry && logId) await scheduleRetry(env, logId, at, score.retry);

  // award find badges (idempotent; counts verified finds inside)
  if (result.verified) await awardFindBadges(env, loggerCall);

  // Cache-owner loop: tell the owner their cache was found (in-app alert + push), unless
  // they found it themselves (under any call their account holds). Reuses the watchlist alert channel.
  const ownerCall = (cache as { owner_call?: string }).owner_call;
  const ownerAcct = ownerCall && !isWithdrawnCall(ownerCall) ? await baseHolder(env, baseCall(ownerCall)) : null;
  if (ownerAcct && ownerAcct !== (await baseHolder(env, baseCall(loggerCall)))) {
    const detail = `${loggerCall} found ${cache.code}${result.verified ? ` · Tier ${result.tier}` : " · unverified"}${foundEarlier(at, now)}`;
    await env.DB.prepare(
      "INSERT INTO watch_alerts (account_id, callsign, kind, detail, cache_id, lat, lon, ts) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(ownerAcct, loggerCall, "cache_found", detail, cacheId, cache.lat ?? null, cache.lon ?? null, now)
      .run();
    await pushAlert(env, ownerAcct);
  }

  // Infrastructure loop: tell the operator whose IGate corroborated this find — their
  // station made the Tier-A verification possible. Closes the corroborator-credit loop.
  if (corrIgate) {
    const igAcct = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ?")
      .bind(baseCall(corrIgate))
      .first<{ account_id: string }>();
    if (igAcct?.account_id) {
      const detail = `Your station ${corrIgate} corroborated ${loggerCall}'s find of ${cache.code} (Tier ${result.tier})`;
      await env.DB.prepare(
        "INSERT INTO watch_alerts (account_id, callsign, kind, detail, cache_id, lat, lon, ts) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(igAcct.account_id, corrIgate, "corroborated", detail, cacheId, cache.lat ?? null, cache.lon ?? null, now)
        .run();
      await pushAlert(env, igAcct.account_id);
    }
  }

  // optional: announce to APRS-IS (opt-in + verified callsign only)
  const announced = await maybeAnnounceFind(env, loggerCall, cache.code, cache.title);
  return { duplicate: false, logId, announced };
}

/** " · found <UTC time>" for a find that reaches the gateway well after it was made (a find queued offline). */
function foundEarlier(at: number, now: number): string {
  return now - at > 300 ? ` · found ${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
}

/** A DNF, note or maintenance log: a plain record, never presence-verified. Returns its id. */
export async function commitPlainLog(
  env: Env,
  cacheId: number,
  loggerCall: string,
  at: number,
  logType: "dnf" | "note" | "maintenance",
  comment: string | null,
): Promise<number | undefined> {
  const r = await env.DB.prepare(
    `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, verify_method, comment)
     VALUES (?,?,?,?, 0, NULL, 'manual', ?)`,
  )
    .bind(cacheId, loggerCall, at, logType, comment)
    .run();
  return Number(r.meta?.last_row_id) || undefined;
}
