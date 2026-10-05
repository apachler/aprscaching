// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * cacheplace.ts — a found cache stays where it was found. Until its first find an owner moves a cache freely;
 * the first find pins every coordinate it has (its own, each stage's), and from then on an owner moves each one
 * at most CACHE_MOVE_LIMIT_M from its pin, so every past find still points to the place its finder visited. A
 * cache that has to go further is archived and hidden anew. A living cache's own coordinates follow its station
 * and are never pinned. The sysop moves any coordinate for a correction, which pins it at the corrected place.
 */
import { haversineMeters } from "@aprscaching/aprs";
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { setting } from "./siteconfig.js";
import { requireSysop } from "./admin.js";
import { resealStage } from "./stages.js";

const CACHE_MOVE_LIMIT_M_DEFAULT = 100;
/** The `stage_no` of a cache's own coordinates in cache_place_pins. */
export const CACHE_POINT = -1;

export interface Pin {
  lat: number;
  lon: number;
}

/** How far (metres) an owner moves a coordinate of a found cache from its pin. `0` keeps it where it was found. */
function moveLimitM(env: Env): number {
  const raw = setting(env, "CACHE_MOVE_LIMIT_M");
  if (raw == null || raw.trim() === "") return CACHE_MOVE_LIMIT_M_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : CACHE_MOVE_LIMIT_M_DEFAULT;
}

/** Pin each coordinate of the cache that has no pin yet, where it stands now. Runs on every find. */
export async function pinPlaces(env: Env, cacheId: number): Promise<void> {
  const at = nowS();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO cache_place_pins (cache_id, stage_no, lat, lon, pinned_at)
       SELECT id, ?, lat, lon, ? FROM caches
        WHERE id = ? AND lat IS NOT NULL AND lon IS NOT NULL AND type != 'aprs_living'`,
    ).bind(CACHE_POINT, at, cacheId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO cache_place_pins (cache_id, stage_no, lat, lon, pinned_at)
       SELECT cache_id, stage_no, lat, lon, ? FROM cache_stages
        WHERE cache_id = ? AND lat IS NOT NULL AND lon IS NOT NULL`,
    ).bind(at, cacheId),
  ]);
}

/**
 * The pins of a cache, by stage number ({@link CACHE_POINT} for its own coordinates); empty before its first
 * find. A cache holding a find but no pin is pinned first, where it stands now: no move has happened since that
 * find, because every move after a find passes through here.
 */
export async function placePins(env: Env, cacheId: number): Promise<Map<number, Pin>> {
  const read = async () =>
    (
      await env.DB.prepare("SELECT stage_no, lat, lon FROM cache_place_pins WHERE cache_id = ?")
        .bind(cacheId)
        .all<{ stage_no: number; lat: number; lon: number }>()
    ).results ?? [];
  let rows = await read();
  if (!rows.length) {
    const found = await env.DB.prepare(
      "SELECT 1 AS x FROM cache_logs WHERE cache_id = ? AND log_type = 'found' LIMIT 1",
    )
      .bind(cacheId)
      .first();
    if (!found) return new Map();
    await pinPlaces(env, cacheId);
    rows = await read();
  }
  return new Map(rows.map((r) => [r.stage_no, { lat: r.lat, lon: r.lon }]));
}

/**
 * Why `what` (a cache or one of its stages) cannot move from its pin to `to`, or null when it can: no pin, or a
 * place within the limit. Clearing a pinned coordinate counts as moving it away.
 */
export function moveRefusal(env: Env, what: string, pin: Pin | undefined, to: Pin | null): string | null {
  if (!pin) return null;
  const limit = moveLimitM(env);
  const tail = "Archive the cache and hide a new one at the new place.";
  if (!to) return `${what} has been found, so it keeps its coordinates. ${tail}`;
  const d = haversineMeters(pin.lat, pin.lon, to.lat, to.lon);
  if (d <= limit) return null;
  return limit === 0
    ? `${what} has been found, so it stays where it was found. ${tail}`
    : `${what} has been found, so it moves at most ${limit} m from where it was found; this place is ${Math.round(d)} m away. ${tail}`;
}

/** What the owner's edit form shows: the limit, and each pin to measure a move from. */
export async function moveRule(
  env: Env,
  cacheId: number,
): Promise<{ limitM: number; pinned: Pin | null; stagePins: Array<{ stageNo: number } & Pin> }> {
  const pins = await placePins(env, cacheId);
  return {
    limitM: moveLimitM(env),
    pinned: pins.get(CACHE_POINT) ?? null,
    stagePins: [...pins]
      .filter(([n]) => n !== CACHE_POINT)
      .sort(([a], [b]) => a - b)
      .map(([stageNo, p]) => ({ stageNo, ...p })),
  };
}

/**
 * POST /api/admin/caches/:id/place `{ lat, lon, stageNo? }` — the sysop corrects a cache's coordinates (or one
 * stage's) beyond the owner's limit, and pins them at the corrected place. Finders' unlocks from a moved stage on
 * are dropped, as an owner's stage edit drops them.
 */
export async function handleAdminCachePlace(req: Request, env: Env, cacheId: number): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { lat?: unknown; lon?: unknown; stageNo?: unknown } | null;
  const lat = Number(b?.lat),
    lon = Number(b?.lon);
  if (!b || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return json({ error: "lat and lon required, in decimal degrees" }, { status: 400 });
  const cache = await env.DB.prepare("SELECT type FROM caches WHERE id = ?").bind(cacheId).first<{ type: string }>();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });
  const at = nowS();
  const stageNo = b.stageNo == null ? null : Number(b.stageNo);
  if (stageNo == null) {
    if (cache.type === "aprs_living")
      return json({ error: "a living cache follows its station; it has no place to correct" }, { status: 409 });
    await env.DB.batch([
      env.DB.prepare("UPDATE caches SET lat = ?, lon = ?, updated_at = ? WHERE id = ?").bind(lat, lon, at, cacheId),
      env.DB.prepare(
        "INSERT OR REPLACE INTO cache_place_pins (cache_id, stage_no, lat, lon, pinned_at) VALUES (?,?,?,?,?)",
      ).bind(cacheId, CACHE_POINT, lat, lon, at),
    ]);
    return json({ ok: true, lat, lon });
  }
  if (!Number.isInteger(stageNo) || stageNo < 0)
    return json({ error: "stageNo must be a stage number" }, { status: 400 });
  const stage = await env.DB.prepare("SELECT 1 AS x FROM cache_stages WHERE cache_id = ? AND stage_no = ?")
    .bind(cacheId, stageNo)
    .first();
  if (!stage) return json({ error: "no such stage" }, { status: 404 });
  await env.DB.batch([
    env.DB.prepare("UPDATE cache_stages SET lat = ?, lon = ? WHERE cache_id = ? AND stage_no = ?").bind(
      lat,
      lon,
      cacheId,
      stageNo,
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO cache_place_pins (cache_id, stage_no, lat, lon, pinned_at) VALUES (?,?,?,?,?)",
    ).bind(cacheId, stageNo, lat, lon, at),
    env.DB.prepare("DELETE FROM stage_unlocks WHERE cache_id = ? AND stage_no >= ?").bind(cacheId, stageNo),
  ]);
  await resealStage(env, cacheId, stageNo);
  return json({ ok: true, stageNo, lat, lon });
}
