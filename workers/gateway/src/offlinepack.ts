// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /api/offline/pack — one offline pack in one answer: the caches of an area (a box, a circle, or a
 * corridor along a route; packages/shared offlinepack.ts) with the details the cache page needs, the
 * latest logs, each cache's stage shape and the list of its images. Federated caches the map shows are
 * included and marked as mirrored. Read-only and public, like the map and the cache page it mirrors.
 *
 * Secrets stay out: a stage is only its number and how it unlocks, never its coordinates, clue or code.
 * A refresh sends the pack's generation as If-None-Match and gets 304 when nothing in the area changed,
 * which costs a few aggregate queries. A full build is rate-limited per address, and an area with more
 * than PACK_MAX_CACHES caches is refused with its count, so the user narrows it.
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
import { json } from "./app.js";
import { nowS } from "./util/time.js";
import { clientIp, rateLimitedDurable } from "./corroborate_privacy.js";
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

const NATIVE_IN_BOX = "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status != 'archived'";

export async function handleOfflinePack(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const area = parsePackArea(u.searchParams);
  if (typeof area === "string") return json({ error: area }, { status: 400 });
  const types = (u.searchParams.get("types") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^[a-z_]{1,32}$/.test(t))
    .slice(0, 12); // D1 binds at most 100 parameters, and the generation query repeats the list four times
  const includeUnvetted = u.searchParams.get("includeUnvetted") === "1";
  const instance = env.INSTANCE ?? u.host;
  const [minLon, minLat, maxLon, maxLat] = areaBounds(area);
  const box = [minLat, maxLat, minLon, maxLon];
  const typeSql = types.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
  const trustSql =
    "COALESCE(fp.trust, 'unvetted') != 'blocked' AND (? = 1 OR COALESCE(fp.trust, 'unvetted') = 'trusted')";

  // The generation: what in the area's box could change the pack. Cheap aggregates, so a refresh with no
  // change costs no build.
  const stat = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM caches WHERE ${NATIVE_IN_BOX}${typeSql}) AS c,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM cache_logs
          WHERE cache_id IN (SELECT id FROM caches WHERE ${NATIVE_IN_BOX}${typeSql})) AS l,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM cache_media
          WHERE cache_id IN (SELECT id FROM caches WHERE ${NATIVE_IN_BOX}${typeSql})) AS m,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(rc.mirrored_at), 0) FROM remote_caches rc
          LEFT JOIN fed_peers fp ON fp.instance = rc.origin
         WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived'${typeSql.replace("type", "rc.type")}
           AND ${trustSql}) AS r`,
  )
    .bind(...box, ...types, ...box, ...types, ...box, ...types, ...box, ...types, includeUnvetted ? 1 : 0)
    .first<{ c: string; l: string; m: string; r: string }>();
  const key = `${u.searchParams.toString()}|${stat?.c}|${stat?.l}|${stat?.m}|${stat?.r}`;
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
    await env.DB.prepare(`SELECT * FROM caches WHERE ${NATIVE_IN_BOX}${typeSql} LIMIT ?`)
      .bind(...box, ...types, scan)
      .all<CacheDbRow>()
  ).results;
  if (nativeRows.length === scan) return tooMany();
  const native = nativeRows.filter((r) => r.lat != null && r.lon != null && inPackArea(area, r.lat, r.lon));
  const remoteRows = (
    await env.DB.prepare(
      `SELECT rc.*, COALESCE(fp.trust, 'unvetted') AS origin_trust FROM remote_caches rc
         LEFT JOIN fed_peers fp ON fp.instance = rc.origin
        WHERE rc.lat BETWEEN ? AND ? AND rc.lon BETWEEN ? AND ? AND rc.status != 'archived'${typeSql.replace("type", "rc.type")}
          AND ${trustSql} LIMIT ?`,
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
  // (an IN list of thousands of ids would exceed D1's bound-parameter limit), kept for the caches in the area.
  const ids = new Set(native.map((r) => r.id));
  const logs = (
    await env.DB.prepare(
      `SELECT * FROM (
         SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.cache_id ORDER BY l.ts DESC, l.id DESC) AS rn
           FROM cache_logs l WHERE l.cache_id IN (SELECT id FROM caches WHERE ${NATIVE_IN_BOX}${typeSql})
       ) WHERE rn <= ?`,
    )
      .bind(...box, ...types, PACK_LOGS_PER_CACHE)
      .all<LogDbRow>()
  ).results;
  const stages = (
    await env.DB.prepare(
      `SELECT cache_id, stage_no, unlock, sealed, lat, lon, clue, media_key FROM cache_stages
        WHERE cache_id IN (SELECT id FROM caches WHERE ${NATIVE_IN_BOX}${typeSql}) ORDER BY stage_no`,
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
        WHERE kind = 'image' AND cache_id IN (SELECT id FROM caches WHERE ${NATIVE_IN_BOX}${typeSql}) ORDER BY created_at`,
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
  const body: PackResponse = { instance, generation, builtAt: nowS(), caches };
  return json(body, { headers: { etag, "cache-control": "no-cache" } });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
