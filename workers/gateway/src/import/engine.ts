// SPDX-License-Identifier: AGPL-3.0-or-later
/** Import engine (M3): upsert normalized records (dedup + update on re-import) + the HTTP entry. */
import type { Env } from "../env.js";
import { json } from "../app.js";
import { haversineMeters } from "@aprsweb/aprs";
import { SOURCES, type ImportedCache, type ImportScope } from "./sources.js";

// Cross-source priority: ham-radio activation programs win over geocaches, which win over generic POI.
const HAM = new Set(["sota", "pota", "wwff", "bunker", "castle", "iota"]);
const GEOCACHE = new Set(["opencaching", "gcau"]);
function rank(source: string): number { return HAM.has(source) ? 1 : GEOCACHE.has(source) ? 2 : 3; }
const DEDUP_RADIUS_M = 100;

/**
 * Insert new imported caches, update existing ones (matched on source + external_id), and
 * de-duplicate ACROSS sources by proximity: a record is skipped if a higher-priority cache is
 * already within DEDUP_RADIUS, and inserting a higher-priority record archives weaker nearby
 * duplicates. Native (user) caches are never touched.
 */
export async function upsertImported(env: Env, records: ImportedCache[]): Promise<{ imported: number; updated: number; skipped: number; deduped: number; superseded: number }> {
  let imported = 0, updated = 0, skipped = 0, deduped = 0, superseded = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const r of records) {
    if (!isFinite(r.lat) || !isFinite(r.lon) || !r.externalId || !r.title) { skipped++; continue; }
    try {
      const existing = await env.DB.prepare("SELECT id FROM caches WHERE source = ? AND external_id = ?")
        .bind(r.source, r.externalId).first<{ id: number }>();
      if (existing) {
        // re-import: refresh content but keep a superseded (archived) row suppressed
        await env.DB.prepare(
          `UPDATE caches SET title=?, type=?, lat=?, lon=?, source_url=?, source_name=?, description=?,
             status = CASE WHEN status='archived' THEN 'archived' ELSE 'active' END,
             updated_at=?, imported_at=? WHERE id=?`,
        ).bind(r.title, r.type, r.lat, r.lon, r.sourceUrl, r.sourceName, r.description ?? null, now, now, existing.id).run();
        updated++;
        continue;
      }

      // cross-source dedup by proximity + priority
      const ri = rank(r.source);
      const dLat = DEDUP_RADIUS_M / 111320;
      const dLon = DEDUP_RADIUS_M / (111320 * Math.max(Math.cos((r.lat * Math.PI) / 180), 0.01));
      const nearby = (await env.DB.prepare(
        `SELECT id, source, lat, lon FROM caches
          WHERE source NOT IN ('native', ?) AND status != 'archived'
            AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
      ).bind(r.source, r.lat - dLat, r.lat + dLat, r.lon - dLon, r.lon + dLon)
        .all<{ id: number; source: string; lat: number; lon: number }>()).results;

      let blocked = false; const weaker: number[] = [];
      for (const nb of nearby) {
        if (haversineMeters(r.lat, r.lon, nb.lat, nb.lon) > DEDUP_RADIUS_M) continue;
        const rn = rank(nb.source);
        if (rn < ri) { blocked = true; break; }   // a higher-priority cache already covers this spot
        if (rn > ri) weaker.push(nb.id);            // we outrank an existing weaker duplicate
      }
      if (blocked) { deduped++; continue; }

      await env.DB.prepare(
        `INSERT INTO caches (code, owner_call, title, type, status, lat, lon, source, external_id,
           source_url, source_name, description, created_at, updated_at, imported_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?, ?,?,?, ?,?,?)`,
      ).bind(r.code, r.ownerCall ?? r.sourceName, r.title, r.type, r.lat, r.lon, r.source, r.externalId,
             r.sourceUrl, r.sourceName, r.description ?? null, now, now, now).run();
      imported++;
      if (weaker.length) {
        await env.DB.batch(weaker.map((id) => env.DB.prepare("UPDATE caches SET status='archived', updated_at=? WHERE id=?").bind(now, id)));
        superseded += weaker.length;
      }
    } catch { skipped++; /* e.g. a cross-source code collision — skip, keep going */ }
  }
  return { imported, updated, skipped, deduped, superseded };
}

export async function runImport(env: Env, sourceId: string, scope: ImportScope): Promise<unknown> {
  const adapter = SOURCES[sourceId];
  if (!adapter) throw new Error(`unknown import source '${sourceId}'`);
  const records = await adapter.load(env, scope);
  const res = await upsertImported(env, records);
  return { source: sourceId, fetched: records.length, ...res };
}

/** POST /api/import/:source — admin-only (x-ingest-secret). Body = ImportScope JSON. */
export async function handleImport(req: Request, env: Env, sourceId: string): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
  if (!SOURCES[sourceId]) return json({ error: `unknown source '${sourceId}'`, sources: Object.keys(SOURCES) }, { status: 404 });
  const scope = (await req.json().catch(() => ({}))) as ImportScope;
  try {
    return json(await runImport(env, sourceId, scope));
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 502 });
  }
}
