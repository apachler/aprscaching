// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";
import type { SearchHitCache, SearchHitStation, SearchResults, CacheType } from "@aprsweb/shared";

/**
 * search.ts — enriched as-you-type suggestions. A single portable endpoint that
 * matches caches (by code / title / owner) and stations (by callsign) with prefix-first ranking.
 * Deliberately LIKE-based, NOT FTS5: Cloudflare D1 forbids virtual tables (see 0001_init.sql), so a
 * plain indexed LIKE keeps the query identical across all three runtimes (Worker/D1, Node, Bun) and
 * is plenty for suggest-sized result sets. The map already handles grid / lat-lon itself client-side.
 */

/** Escape the LIKE wildcards in user input so a literal % / _ / \ can't widen the match. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface CacheHitRow { id: number; code: string; owner_call: string; title: string; type: string; lat: number | null; lon: number | null }
interface StationHitRow { callsign: string; symbol: string | null; lat: number | null; lon: number | null; comment: string | null }

export async function handleSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 8, 1), 20);
  if (q.length < 2) return json({ caches: [], stations: [] } satisfies SearchResults);

  const esc = likeEscape(q);
  const contains = `%${esc}%`, prefix = `${esc}%`;

  // Caches: contains-match across code/title/owner; rank prefix-of-code first, then code, then title.
  // Plain positional ? (bound repeatedly) for portability — D1 doesn't reliably support ?N reuse.
  const cacheRows = (await env.DB.prepare(
    `SELECT id, code, owner_call, title, type, lat, lon FROM caches
       WHERE status != 'archived'
         AND (code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR owner_call LIKE ? ESCAPE '\\')
       ORDER BY
         CASE WHEN code LIKE ? ESCAPE '\\' THEN 0
              WHEN code LIKE ? ESCAPE '\\' THEN 1
              WHEN title LIKE ? ESCAPE '\\' THEN 2
              ELSE 3 END,
         length(code)
       LIMIT ?`,
  ).bind(contains, contains, contains, prefix, contains, contains, limit).all<CacheHitRow>()).results;

  // Stations: callsign match, prefix-first then most-recently heard.
  const stationRows = (await env.DB.prepare(
    `SELECT callsign, symbol, lat, lon, comment FROM stations
       WHERE callsign LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN callsign LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, last_seen DESC
       LIMIT ?`,
  ).bind(contains, prefix, limit).all<StationHitRow>()).results;

  const caches: SearchHitCache[] = cacheRows.map((r) => ({
    kind: "cache", id: r.id, code: r.code, title: r.title, ownerCall: r.owner_call,
    type: r.type as CacheType, lat: r.lat, lon: r.lon,
  }));
  const stations: SearchHitStation[] = stationRows.map((r) => ({
    kind: "station", callsign: r.callsign, symbol: r.symbol, lat: r.lat, lon: r.lon, comment: r.comment,
  }));
  return json({ caches, stations } satisfies SearchResults);
}
