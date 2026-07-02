// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * paging.ts — keyset (cursor) pagination for linear list endpoints.
 *
 * Lists ordered by a time/serial key page by an opaque cursor over (primary, id) DESC, not OFFSET.
 * Keyset is O(log n) on an index and is immune to row drift when new items are inserted between
 * page fetches — the federation feeds already prove the pattern (federation.ts).
 *
 * Usage in a handler:
 *   const pg = parsePage(url);                                    // { limit, cursor }
 *   const ks = keyset(pg.cursor, "l.ts", "l.id");                 // WHERE fragment + binds
 *   const rows = (await env.DB.prepare(
 *     `SELECT ... WHERE 1=1${ks.sql} ORDER BY l.ts DESC, l.id DESC LIMIT ?`
 *   ).bind(...ks.binds, pg.limit + 1).all()).results;             // fetch limit + 1
 *   const page = paginate(rows, pg.limit, (r) => ({ primary: r.ts, id: r.id }));
 *   return json({ activity: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
 */

export interface Cursor { primary: number; id: number }
export interface PageParams { limit: number; cursor: Cursor | null }

const b64url = (s: string): string => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): string => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export function encodeCursor(c: Cursor): string { return b64url(`${c.primary}:${c.id}`); }

export function decodeCursor(s: string | null): Cursor | null {
  if (!s) return null;
  try {
    const [p, i] = unb64url(s).split(":");
    const primary = Number(p), id = Number(i);
    return Number.isFinite(primary) && Number.isFinite(id) ? { primary, id } : null;
  } catch { return null; }
}

/** Parse ?limit= (clamped to [1,max]) and ?cursor= from the request URL. */
export function parsePage(u: URL, def = 25, max = 100): PageParams {
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? def) || def, 1), max);
  return { limit, cursor: decodeCursor(u.searchParams.get("cursor")) };
}

/**
 * Keyset WHERE fragment for DESC ordering on (primaryCol, idCol). Returns "" + [] when there is no
 * cursor (first page). The composite comparison is tie-safe: APRS bursts share a `ts`, so we fall
 * through to the id to avoid losing or repeating rows at a second boundary.
 */
export function keyset(cursor: Cursor | null, primaryCol: string, idCol: string): { sql: string; binds: number[] } {
  if (!cursor) return { sql: "", binds: [] };
  return { sql: ` AND (${primaryCol} < ? OR (${primaryCol} = ? AND ${idCol} < ?))`, binds: [cursor.primary, cursor.primary, cursor.id] };
}

/** Slice a (limit+1)-row fetch into a page + its nextCursor. `keyOf` maps the last kept row to a cursor. */
export function paginate<T>(rows: T[], limit: number, keyOf: (r: T) => Cursor): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(keyOf(last)) : null;
  return { items, nextCursor, hasMore };
}
