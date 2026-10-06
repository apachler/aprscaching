// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "../util/time.js";
import { requireSysop } from "../admin.js";
/** Import engine: upsert normalized records (dedup + update on re-import) + the HTTP entry. */
import type { Env } from "../env.js";
import { json } from "../http.js";
import { setting } from "../siteconfig.js";
import { haversineMeters } from "@aprscaching/aprs";
import { webLink } from "@aprscaching/shared";
import { SOURCES, type ImportedCache, type ImportScope } from "./sources.js";

// Cross-source priority: ham-radio activation programs win over geocaches, which win over generic POI.
const HAM = new Set(["sota", "pota", "wwff", "bunker", "castle", "iota"]);
const GEOCACHE = new Set(["opencaching", "gcau"]);
function rank(source: string): number {
  return HAM.has(source) ? 1 : GEOCACHE.has(source) ? 2 : 3;
}
const DEDUP_RADIUS_M = 100;

/** An import the source's terms do not allow this instance yet; the message names what it needs. */
export class ImportNotPermitted extends Error {}

/** The sources the operator holds permission for (IMPORT_ALLOW, comma-separated ids). */
function allowedSources(env: Env): Set<string> {
  return new Set(
    (setting(env, "IMPORT_ALLOW") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Why `sourceId` may not import on this instance, or null when it may. */
export function importBlocked(env: Env, sourceId: string): string | null {
  const need = SOURCES[sourceId]?.needsPermission;
  if (!need || allowedSources(env).has(sourceId)) return null;
  return `${sourceId}: needs ${need}. Once granted, add ${sourceId} to IMPORT_ALLOW.`;
}

const attributionJson = (r: ImportedCache): string | null =>
  r.sourceAttribution?.length ? JSON.stringify(r.sourceAttribution) : null;

/**
 * Insert new imported caches, update existing ones (matched on source + external_id), and
 * de-duplicate ACROSS sources by proximity: a record is skipped if a higher-priority cache is
 * already within DEDUP_RADIUS, and inserting a higher-priority record archives weaker nearby
 * duplicates. A listing the sysop removed (import_removals) is withheld. Native (user) caches are never touched.
 */
export async function upsertImported(
  env: Env,
  records: ImportedCache[],
): Promise<{
  imported: number;
  updated: number;
  skipped: number;
  deduped: number;
  superseded: number;
  withheld: number;
}> {
  let imported = 0,
    updated = 0,
    skipped = 0,
    deduped = 0,
    superseded = 0,
    withheld = 0;
  const now = nowS();
  for (const r of records) {
    if (!isFinite(r.lat) || !isFinite(r.lon) || !r.externalId || !r.title) {
      skipped++;
      continue;
    }
    // a listing link from a source's data is kept only as an http(s) address: the detail view renders it as a link
    const sourceUrl = webLink(r.sourceUrl);
    try {
      // a listing the sysop removed stays removed, whatever the source still offers
      const removed = await env.DB.prepare("SELECT 1 AS x FROM import_removals WHERE source = ? AND external_id = ?")
        .bind(r.source, r.externalId)
        .first();
      if (removed) {
        withheld++;
        continue;
      }
      const existing = await env.DB.prepare("SELECT id FROM caches WHERE source = ? AND external_id = ?")
        .bind(r.source, r.externalId)
        .first<{ id: number }>();
      if (existing) {
        // re-import: refresh content but keep a superseded (archived) row suppressed
        await env.DB.prepare(
          `UPDATE caches SET title=?, type=?, lat=?, lon=?, source_url=?, source_name=?, description=?,
             source_owner=?, source_attribution=?,
             status = CASE WHEN status='archived' THEN 'archived' ELSE 'active' END,
             updated_at=?, imported_at=? WHERE id=?`,
        )
          .bind(
            r.title,
            r.type,
            r.lat,
            r.lon,
            sourceUrl,
            r.sourceName,
            r.description ?? null,
            r.sourceOwner ?? null,
            attributionJson(r),
            now,
            now,
            existing.id,
          )
          .run();
        updated++;
        continue;
      }

      // cross-source dedup by proximity + priority
      const ri = rank(r.source);
      const dLat = DEDUP_RADIUS_M / 111320;
      const dLon = DEDUP_RADIUS_M / (111320 * Math.max(Math.cos((r.lat * Math.PI) / 180), 0.01));
      const nearby = (
        await env.DB.prepare(
          `SELECT id, source, lat, lon FROM caches
          WHERE source NOT IN ('native', ?) AND status != 'archived'
            AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
        )
          .bind(r.source, r.lat - dLat, r.lat + dLat, r.lon - dLon, r.lon + dLon)
          .all<{ id: number; source: string; lat: number; lon: number }>()
      ).results;

      let blocked = false;
      const weaker: number[] = [];
      for (const nb of nearby) {
        if (haversineMeters(r.lat, r.lon, nb.lat, nb.lon) > DEDUP_RADIUS_M) continue;
        const rn = rank(nb.source);
        if (rn < ri) {
          blocked = true;
          break;
        } // a higher-priority cache already covers this spot
        if (rn > ri) weaker.push(nb.id); // we outrank an existing weaker duplicate
      }
      if (blocked) {
        deduped++;
        continue;
      }

      await env.DB.prepare(
        `INSERT INTO caches (code, owner_call, title, type, status, lat, lon, source, external_id,
           source_url, source_name, description, source_owner, source_attribution, created_at, updated_at, imported_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?, ?,?,?,?,?, ?,?,?)`,
      )
        .bind(
          r.code,
          r.ownerCall ?? r.sourceName,
          r.title,
          r.type,
          r.lat,
          r.lon,
          r.source,
          r.externalId,
          sourceUrl,
          r.sourceName,
          r.description ?? null,
          r.sourceOwner ?? null,
          attributionJson(r),
          now,
          now,
          now,
        )
        .run();
      imported++;
      if (weaker.length) {
        await env.DB.batch(
          weaker.map((id) =>
            env.DB.prepare("UPDATE caches SET status='archived', updated_at=? WHERE id=?").bind(now, id),
          ),
        );
        superseded += weaker.length;
      }
    } catch {
      skipped++; /* e.g. a cross-source code collision — skip, keep going */
    }
  }
  return { imported, updated, skipped, deduped, superseded, withheld };
}

export async function runImport(env: Env, sourceId: string, scope: ImportScope): Promise<unknown> {
  const adapter = SOURCES[sourceId];
  if (!adapter) throw new Error(`unknown import source '${sourceId}'`);
  const blocked = importBlocked(env, sourceId);
  if (blocked) throw new ImportNotPermitted(blocked);
  const records = await adapter.load(env, scope);
  const res = await upsertImported(env, records);
  return { source: sourceId, fetched: records.length, ...res };
}

/** POST /api/import/:source — the sysop (a session, or x-operator-secret for a script). Body = ImportScope JSON. */
export async function handleImport(req: Request, env: Env, sourceId: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  if (!SOURCES[sourceId])
    return json({ error: `unknown source '${sourceId}'`, sources: Object.keys(SOURCES) }, { status: 404 });
  const scope = (await req.json().catch(() => ({}))) as ImportScope;
  try {
    return json(await runImport(env, sourceId, scope));
  } catch (e) {
    if (e instanceof ImportNotPermitted) return json({ error: e.message }, { status: 403 });
    return json({ error: (e as Error).message }, { status: 502 });
  }
}

/** GET /api/import — the sysop: each source and whether this instance may import it. */
export async function handleImportSources(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  return json({
    sources: Object.values(SOURCES).map((s) => {
      const blocked = importBlocked(env, s.id);
      return blocked
        ? { id: s.id, sourceName: s.sourceName, state: "needs-permission", needs: s.needsPermission }
        : { id: s.id, sourceName: s.sourceName, state: "ready" };
    }),
  });
}

const PLACES_PAGE = 50;

interface ImportedPlaceRow {
  id: number;
  code: string;
  title: string;
  source: string;
  source_name: string | null;
  external_id: string | null;
  status: string;
}

/**
 * GET /api/admin/imports?q=&source= — the sysop finds imported places by code, title or source id (at most 50,
 * newest import first), and sees the listings removed so far.
 */
export async function handleImportedPlaces(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const source = (url.searchParams.get("source") ?? "").trim().toLowerCase();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const places = (
    await env.DB.prepare(
      `SELECT id, code, title, source, source_name, external_id, status FROM caches
        WHERE source != 'native' AND (? = '' OR source = ?)
          AND (? = '' OR code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\')
        ORDER BY imported_at DESC, id DESC LIMIT ?`,
    )
      .bind(source, source, q, like, like, like, PLACES_PAGE)
      .all<ImportedPlaceRow>()
  ).results;
  const removed = (
    await env.DB.prepare(
      "SELECT source, external_id, code, note, removed_at FROM import_removals ORDER BY removed_at DESC LIMIT ?",
    )
      .bind(PLACES_PAGE)
      .all<{ source: string; external_id: string; code: string | null; note: string | null; removed_at: number }>()
  ).results;
  return json({
    places: places.map((p) => ({
      id: p.id,
      code: p.code,
      title: p.title,
      source: p.source,
      sourceName: p.source_name,
      externalId: p.external_id,
      status: p.status,
    })),
    removed: removed.map((r) => ({
      source: r.source,
      externalId: r.external_id,
      code: r.code,
      note: r.note,
      removedAt: r.removed_at,
    })),
  });
}

/** Every row that belongs to one cache, keyed by its id. */
const CACHE_ROWS = [
  "cache_logs",
  "cache_ratings",
  "cache_media",
  "cache_stages",
  "stage_unlocks",
  "favorites",
  "watches",
  "watch_alerts",
  "near_cache_messages",
  "cache_adoption_offers",
  "cache_adoption_requests",
  "cache_adoptions",
];

/**
 * DELETE /api/admin/imports/:id {note?} — remove one imported place, at the request of its source or of the
 * listing's owner (OpenCaching's terms ask for it). The place goes with every row attached to it (logs,
 * ratings, media, alerts), and its source and listing id are recorded, so a later import of the same source
 * does not bring it back. A native cache is never removed here.
 */
export async function handleRemoveImportedPlace(req: Request, env: Env, id: number): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const place = await env.DB.prepare(
    "SELECT id, code, title, source, source_name, external_id, status FROM caches WHERE id = ?",
  )
    .bind(id)
    .first<ImportedPlaceRow>();
  if (!place) return json({ error: "no such place" }, { status: 404 });
  if (place.source === "native" || !place.external_id)
    return json({ error: "not an imported place: a member's cache is not removed here" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) || null : null;

  const keys = (
    await env.DB.prepare(
      `SELECT media_key AS k FROM cache_media WHERE cache_id = ?
       UNION SELECT media_key AS k FROM cache_stages WHERE cache_id = ? AND media_key IS NOT NULL`,
    )
      .bind(id, id)
      .all<{ k: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO import_removals (source, external_id, code, note, removed_at) VALUES (?,?,?,?,?)
       ON CONFLICT(source, external_id) DO UPDATE SET code = excluded.code, note = excluded.note,
         removed_at = excluded.removed_at`,
    ).bind(place.source, place.external_id, place.code, note, nowS()),
    ...CACHE_ROWS.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE cache_id = ?`).bind(id)),
    env.DB.prepare("UPDATE radio_commands SET cache_id = NULL WHERE cache_id = ?").bind(id),
    env.DB.prepare("DELETE FROM caches WHERE id = ?").bind(id),
  ]);
  for (const { k } of keys) await Promise.resolve(env.MEDIA?.delete?.(k)).catch(() => undefined);
  return json({ removed: true, code: place.code, source: place.source, externalId: place.external_id });
}
