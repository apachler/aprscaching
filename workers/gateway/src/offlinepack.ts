// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /api/offline/pack — one offline pack in one answer: the caches of a Maidenhead locator square
 * (`grid=`; packages/shared offlinepack.ts) with the details the cache page needs, the latest logs, each
 * cache's stage shape and the list of its images. Federated caches the map shows are included and marked as
 * mirrored. Read-only and public, like the map and the cache page it mirrors.
 *
 * `mine=1` is the owner's maintenance pack instead: every cache the signed-in account owns, wherever it is,
 * each with what calls for a visit (several did-not-finds in a row, no find for months, disabled).
 *
 * Secrets stay out: a later stage is only its number and how it unlocks, or its reveal sealed under its tag
 * code. A refresh sends the pack's generation as If-None-Match and gets 304 when nothing in the pack changed,
 * which costs a few aggregate queries. A full build is rate-limited per address, and a pack of more than
 * PACK_MAX_CACHES caches is refused with its count, so the user narrows it.
 */
import {
  PACK_LOGS_PER_CACHE,
  PACK_MAX_CACHES,
  areaBounds,
  inPackArea,
  parsePackArea,
  type PackCache,
  type PackImage,
  type PackResponse,
  type SealedStage,
} from "@aprscaching/shared";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { nowS } from "./util/time.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";
import { sessionIdentity } from "./auth.js";
import { serviceCall } from "./servicecall.js";
import {
  toSummary,
  nativeMapCache,
  remoteMapCache,
  toLogEntry,
  type CacheDbRow,
  type LogDbRow,
  type RemoteCacheRow,
} from "./caches.js";

/** Full pack builds per address per hour (a 304 refresh is not counted). */
const PACK_BUILDS_PER_HOUR = 30;

const NATIVE_IN_BOX =
  "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status != 'archived' AND removed_at IS NULL AND fed_scope != 'unlisted'";
/** A cache unfound for this long is flagged in the owner's pack. */
const QUIET_S = 180 * 86_400;
/** The most calls of one account the owner's pack matches (keeps the query's bound parameters under 100). */
const MAX_OWN_CALLS = 8;

export async function handleOfflinePack(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const area = parsePackArea(u.searchParams);
  if (typeof area === "string") return json({ error: area }, { status: 400 });
  const types = (u.searchParams.get("types") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^[a-z_]{1,32}$/.test(t))
    .slice(0, 12); // the generation query repeats the list twice; this keeps it well under 100 parameters
  const includeUnvetted = u.searchParams.get("includeUnvetted") === "1";
  const instance = env.INSTANCE ?? u.host;
  const mine = "mine" in area;
  // Which native caches the pack takes: those in the locator's box, or those the signed-in account owns.
  let scopeSql = NATIVE_IN_BOX;
  let scopeBinds: (string | number)[];
  if (mine) {
    const me = await sessionIdentity(req, env);
    if (!me) return json({ error: "sign in to pack your own caches" }, { status: 401 });
    const calls = (
      await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id = ? LIMIT ?")
        .bind(me.accountId, MAX_OWN_CALLS)
        .all<{ callsign: string }>()
    ).results.map((r) => r.callsign.toUpperCase());
    if (!calls.length) calls.push(me.base);
    // an owner call is the base call or one of its SSIDs
    scopeSql = `status != 'archived' AND (${calls.map(() => "owner_call = ? OR owner_call LIKE ?").join(" OR ")})`;
    scopeBinds = calls.flatMap((c) => [c, `${c}-%`]);
  } else {
    const [minLon, minLat, maxLon, maxLat] = areaBounds(area);
    scopeBinds = [minLat, maxLat, minLon, maxLon];
  }
  const box = scopeBinds;
  const typeSql = types.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
  const trustSql =
    "COALESCE(fp.trust, 'unvetted') != 'blocked' AND (? = 1 OR COALESCE(fp.trust, 'unvetted') = 'trusted')";

  // The generation: what in the area's box could change the pack. Cheap aggregates, so a refresh with no
  // change costs no build. A log rewritten in place (anonymised by an erasure, removed by the sysop, edited)
  // changes neither the count nor the highest id, so the logs' revision count (cache_log_revs) is part of it.
  const stat = await env.DB.prepare(
    `WITH s AS (SELECT id, updated_at FROM caches WHERE ${scopeSql}${typeSql})
     SELECT
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM s) AS c,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM cache_logs WHERE cache_id IN (SELECT id FROM s))
         || ':' || (SELECT COALESCE(SUM(rev), 0) FROM cache_log_revs WHERE cache_id IN (SELECT id FROM s)) AS l,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM cache_media WHERE cache_id IN (SELECT id FROM s)) AS m,
       ${
         mine
           ? "'' AS r"
           : `(SELECT COUNT(*) || ':' || COALESCE(MAX(rc.mirrored_at), 0) FROM remote_caches rc
          LEFT JOIN fed_peers fp ON fp.instance = rc.origin
         WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived'${typeSql.replace("type", "rc.type")}
           AND rc.fed_scope != 'unlisted' AND ${trustSql}) AS r`
       }`,
  )
    .bind(...box, ...types, ...(mine ? [] : [...box, ...types, includeUnvetted ? 1 : 0]))
    .first<{ c: string; l: string; m: string; r: string }>();
  const who = mine ? `${(await sessionIdentity(req, env))?.accountId}|` : "";
  const key = `${who}${u.searchParams.toString()}|${stat?.c}|${stat?.l}|${stat?.m}|${stat?.r}`;
  const generation = await sha256Hex(key);
  const etag = `"${generation}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });

  if (await rateLimitedDurable(env, `pack:${clientIp(req, env)}`, Date.now(), PACK_BUILDS_PER_HOUR, 3_600_000))
    return json({ error: "too many pack downloads; try again within the hour" }, { status: 429 });

  // read at most this many rows of the box: past it the area is too large however the circle or corridor cuts it
  const scan = PACK_MAX_CACHES * 4;
  const tooMany = () =>
    json({ error: `more than ${PACK_MAX_CACHES} caches in this area; narrow it`, count: null }, { status: 413 });
  const nativeRows = (
    await env.DB.prepare(`SELECT * FROM caches WHERE ${scopeSql}${typeSql} LIMIT ?`)
      .bind(...box, ...types, scan)
      .all<CacheDbRow>()
  ).results;
  if (nativeRows.length === scan) return tooMany();
  const native = mine
    ? nativeRows
    : nativeRows.filter((r) => r.lat != null && r.lon != null && inPackArea(area, r.lat, r.lon));
  const remoteRows = mine
    ? []
    : (
        await env.DB.prepare(
          `SELECT rc.*, COALESCE(fp.trust, 'unvetted') AS origin_trust FROM remote_caches rc
         LEFT JOIN fed_peers fp ON fp.instance = rc.origin
        WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived'${typeSql.replace("type", "rc.type")}
          AND rc.fed_scope != 'unlisted' AND ${trustSql} LIMIT ?`,
        )
          .bind(...box, ...types, includeUnvetted ? 1 : 0, scan)
          .all<
            RemoteCacheRow & {
              hint: string | null;
              description: string | null;
              created_at: number | null;
              updated_at: number | null;
            }
          >()
      ).results;
  if (remoteRows.length === scan) return tooMany();
  const remote = remoteRows.filter((r) => r.lat != null && r.lon != null && inPackArea(area, r.lat, r.lon));
  const count = native.length + remote.length;
  if (count > PACK_MAX_CACHES)
    return json(
      { error: `${count} caches in this area; a pack holds at most ${PACK_MAX_CACHES}`, count },
      { status: 413 },
    );

  // The latest logs, the stage shape and the images of the native caches, each in one query over the box
  // (an IN list of thousands of ids would bind thousands of parameters), kept for the caches in the area.
  const ids = new Set(native.map((r) => r.id));
  const logs = (
    await env.DB.prepare(
      `SELECT * FROM (
         SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.cache_id ORDER BY l.ts DESC, l.id DESC) AS rn
           FROM cache_logs l WHERE l.cache_id IN (SELECT id FROM caches WHERE ${scopeSql}${typeSql})
       ) WHERE rn <= ? ORDER BY cache_id, ts DESC, id DESC`,
    )
      .bind(...box, ...types, PACK_LOGS_PER_CACHE)
      .all<LogDbRow>()
  ).results;
  const stages = (
    await env.DB.prepare(
      `SELECT cache_id, stage_no, unlock, sealed, lat, lon, clue, media_key FROM cache_stages
        WHERE cache_id IN (SELECT id FROM caches WHERE ${scopeSql}${typeSql}) ORDER BY stage_no`,
    )
      .bind(...box, ...types)
      .all<{
        cache_id: number;
        stage_no: number;
        unlock: string | null;
        sealed: string | null;
        lat: number | null;
        lon: number | null;
        clue: string | null;
        media_key: string | null;
      }>()
  ).results;
  const media = (
    await env.DB.prepare(
      `SELECT id, cache_id, media_key, content_type, title, bytes, thumb_key, thumb_bytes FROM cache_media
        WHERE kind = 'image' AND cache_id IN (SELECT id FROM caches WHERE ${scopeSql}${typeSql}) ORDER BY created_at`,
    )
      .bind(...box, ...types)
      .all<{
        id: number;
        cache_id: number;
        media_key: string;
        content_type: string;
        title: string | null;
        bytes: number;
        thumb_key: string | null;
        thumb_bytes: number | null;
      }>()
  ).results;
  const byCache = <T extends { cache_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) if (ids.has(r.cache_id)) m.set(r.cache_id, [...(m.get(r.cache_id) ?? []), r]);
    return m;
  };
  const logsOf = byCache(logs);
  // the owner's pack: when each cache was last found, for the "no find for months" flag
  const lastFound = new Map<number, number>();
  if (mine)
    for (const r of (
      await env.DB.prepare(
        `SELECT cache_id, MAX(ts) AS ts FROM cache_logs WHERE log_type = 'found'
           AND cache_id IN (SELECT id FROM caches WHERE ${scopeSql}${typeSql}) GROUP BY cache_id`,
      )
        .bind(...box, ...types)
        .all<{ cache_id: number; ts: number }>()
    ).results)
      lastFound.set(r.cache_id, r.ts);
  const now = nowS();
  /** What calls for the owner's visit. */
  const attentionOf = (r: CacheDbRow, recent: LogDbRow[]): string[] => {
    const out: string[] = [];
    let dnfs = 0;
    for (const l of recent.filter((l) => l.log_type === "found" || l.log_type === "dnf")) {
      if (l.log_type !== "dnf") break;
      dnfs++;
    }
    if (dnfs >= 3) out.push(`${dnfs} did-not-finds in a row`);
    const found = lastFound.get(r.id);
    if (found != null ? now - found > QUIET_S : now - r.created_at > QUIET_S)
      out.push(found != null ? `no find for ${Math.floor((now - found) / (30 * 86_400))} months` : "never found");
    if (r.status === "disabled") out.push("disabled");
    return out;
  };
  const stagesOf = byCache(stages);
  const mediaOf = byCache(media);

  const caches: PackCache[] = [
    ...native.map((r) => {
      const s = toSummary(r);
      return {
        ...nativeMapCache(r, instance),
        stationCall: s.stationCall,
        minTrust: s.minTrust,
        fedScope: s.fedScope,
        driveIn: s.driveIn,
        country: s.country,
        tags: s.tags,
        sourceOwner: s.sourceOwner,
        sourceAttribution: s.sourceAttribution,
        externalId: r.external_id,
        hint: r.hint,
        description: r.description,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        stages: (stagesOf.get(r.id) ?? []).map((s) => ({
          stageNo: s.stage_no,
          unlock: s.unlock ?? "geo",
          // what a later stage reveals, sealed under its tag code (never the code or the clear payload); the
          // published start is public
          ...(s.stage_no === 0
            ? {
                open: {
                  lat: s.lat,
                  lon: s.lon,
                  clue: s.clue,
                  mediaUrl: s.media_key ? `/api/media/${s.media_key}` : null,
                },
              }
            : s.sealed
              ? { sealed: JSON.parse(s.sealed) as SealedStage }
              : {}),
        })),
        logs: (logsOf.get(r.id) ?? []).map(toLogEntry),
        ...(mine && { attention: attentionOf(r, logsOf.get(r.id) ?? []) }),
        images: (mediaOf.get(r.id) ?? []).map((m): PackImage => ({
          id: m.id,
          url: `/api/media/${m.media_key}`,
          contentType: m.content_type,
          title: m.title,
          bytes: m.bytes,
          thumbUrl: m.thumb_key ? `/api/media/${m.thumb_key}` : null,
          thumbBytes: m.thumb_bytes,
        })),
      };
    }),
    ...remote.map((r) => ({
      ...remoteMapCache(r),
      stationCall: r.station_call,
      minTrust: (r.min_trust as "A" | "B" | null) ?? null,
      fedScope: "public" as const,
      driveIn: false,
      country: null,
      tags: [],
      sourceOwner: null,
      sourceAttribution: null,
      externalId: r.external_id,
      hint: r.hint ?? null,
      description: r.description ?? null,
      createdAt: r.created_at ?? null,
      updatedAt: r.updated_at ?? null,
      stages: [],
      logs: [],
      images: [],
    })),
  ];
  const body: PackResponse = { instance, serviceCall: serviceCall(env), generation, builtAt: now, caches };
  return json(body, { headers: { etag, "cache-control": "no-cache" } });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
