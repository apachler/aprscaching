// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./http.js";
import { displayCall } from "./auth.js";
import { listedOrOwn, remoteMapCache, type RemoteCacheRow } from "./caches.js";
import type { SearchHitCache, SearchHitStation, SearchResults, CacheType } from "@aprscaching/shared";

/**
 * search.ts — enriched as-you-type suggestions. A single portable endpoint that
 * matches caches (by code / title / owner) and stations (by callsign) with prefix-first ranking. The caches
 * mirrored from federation peers are searched too, after this instance's own and under the map's trust policy:
 * a trusted origin's caches, an unvetted origin's with `?includeUnvetted=1`, a blocked origin's never.
 * Deliberately LIKE-based, NOT FTS5: the schema holds no virtual tables (see 0001_baseline.sql), so a
 * plain indexed LIKE keeps the query identical on every SQLite driver (better-sqlite3, bun:sqlite) and
 * is plenty for suggest-sized result sets. The map already handles grid / lat-lon itself client-side.
 */

/** Escape the LIKE wildcards in user input so a literal % / _ / \ can't widen the match. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface CacheHitRow {
  id: number;
  code: string;
  owner_call: string;
  title: string;
  type: string;
  lat: number | null;
  lon: number | null;
}
interface StationHitRow {
  callsign: string;
  symbol: string | null;
  lat: number | null;
  lon: number | null;
  comment: string | null;
}

export async function handleSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 8, 1), 20);
  if (q.length < 2) return json({ caches: [], stations: [] } satisfies SearchResults);

  const esc = likeEscape(q);
  const contains = `%${esc}%`,
    prefix = `${esc}%`;

  const listed = await listedOrOwn(req, env);
  // Caches: contains-match across code/title/owner; rank prefix-of-code first, then code, then title.
  // Plain positional ? (bound repeatedly) for portability across SQLite drivers.
  const cacheRows = (
    await env.DB.prepare(
      `SELECT id, code, owner_call, title, type, lat, lon FROM caches
       WHERE status != 'archived' AND removed_at IS NULL AND ${listed.sql}
         AND (code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR owner_call LIKE ? ESCAPE '\\')
       ORDER BY
         CASE WHEN code LIKE ? ESCAPE '\\' THEN 0
              WHEN code LIKE ? ESCAPE '\\' THEN 1
              WHEN title LIKE ? ESCAPE '\\' THEN 2
              ELSE 3 END,
         length(code)
       LIMIT ?`,
    )
      .bind(...listed.binds, contains, contains, contains, prefix, contains, contains, limit)
      .all<CacheHitRow>()
  ).results;

  // Mirrored caches fill what is left of the limit, each carrying its home instance (codes repeat across instances).
  const includeUnvetted = u.searchParams.get("includeUnvetted") === "1";
  const room = limit - cacheRows.length;
  const remoteRows =
    room > 0
      ? (
          await env.DB.prepare(
            `SELECT rc.*, COALESCE(fp.trust, 'unvetted') AS origin_trust, fp.url AS origin_url
               FROM remote_caches rc
               LEFT JOIN fed_peers fp ON fp.instance = rc.origin
              WHERE rc.status != 'archived' AND rc.fed_scope != 'unlisted'
                AND COALESCE(fp.trust, 'unvetted') != 'blocked'
                AND (? = 1 OR COALESCE(fp.trust, 'unvetted') = 'trusted')
                AND (rc.code LIKE ? ESCAPE '\\' OR rc.title LIKE ? ESCAPE '\\' OR rc.owner_call LIKE ? ESCAPE '\\')
              ORDER BY
                CASE WHEN rc.code LIKE ? ESCAPE '\\' THEN 0
                     WHEN rc.code LIKE ? ESCAPE '\\' THEN 1
                     WHEN rc.title LIKE ? ESCAPE '\\' THEN 2
                     ELSE 3 END,
                length(rc.code)
              LIMIT ?`,
          )
            .bind(includeUnvetted ? 1 : 0, contains, contains, contains, prefix, contains, contains, room)
            .all<RemoteCacheRow>()
        ).results
      : [];

  // Stations: callsign match, prefix-first then most-recently heard.
  const stationRows = (
    await env.DB.prepare(
      `SELECT callsign, symbol, lat, lon, comment FROM stations
       WHERE callsign LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN callsign LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, last_seen DESC
       LIMIT ?`,
    )
      .bind(contains, prefix, limit)
      .all<StationHitRow>()
  ).results;

  const caches: SearchHitCache[] = cacheRows.map((r) => ({
    kind: "cache",
    id: r.id,
    code: r.code,
    title: r.title,
    ownerCall: displayCall(r.owner_call),
    type: r.type as CacheType,
    lat: r.lat,
    lon: r.lon,
  }));
  for (const r of remoteRows) {
    const m = remoteMapCache(r);
    caches.push({
      kind: "cache",
      id: null,
      code: m.code,
      title: m.title,
      ownerCall: displayCall(m.ownerCall ?? ""),
      type: m.type,
      lat: m.lat,
      lon: m.lon,
      remote: m,
    });
  }
  const stations: SearchHitStation[] = stationRows.map((r) => ({
    kind: "station",
    callsign: r.callsign,
    symbol: r.symbol,
    lat: r.lat,
    lon: r.lon,
    comment: r.comment,
  }));
  return json({ caches, stations } satisfies SearchResults);
}
