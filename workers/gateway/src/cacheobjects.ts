// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * cacheobjects.ts — the caches near the instance's transmitting ingest box, sent on air as APRS objects with the
 * point-of-interest symbol (`\i`), so any APRS radio or map nearby shows them. Off by default; the sysop turns it
 * on in Instance admin → Instance settings (`CACHE_OBJECTS`, a site setting, so every change passes
 * `requireSysop`).
 *
 * WB2OSZ's _APRS Worst Practices_ is the checklist:
 *  - local reach only: no digipeater path, or `WIDE1-1` at most (`CACHE_OBJECTS_PATH`), never a wide path;
 *  - no objects far from the transmitter: only caches within `CACHE_OBJECTS_RADIUS_KM` (at most 50 km) of the
 *    position the box itself reports, and the box refuses any object more than 50 km from where it stands;
 *  - no frequent repeats: a new or changed object goes out at once, again 5, 10 and 20 minutes apart, then every
 *    `CACHE_OBJECTS_INTERVAL_MIN` (30 minutes or more), and a run sends `CACHE_OBJECTS_PER_RUN` objects at most;
 *  - objects are killed properly: a cache that is archived, disabled, removed, moved out of range or no longer
 *    public goes out with the killed flag (`_`) three times, and then no more;
 *  - the object name is the cache code (at most nine characters) and the comment its title, short.
 *
 * Only a cache's published coordinates go on air: `caches.lat/lon`, a staged cache's public start, never a later
 * stage. Only native, active, public caches are sent; a living cache is its own station and is never an object.
 *
 * The transmit path is the box-command one: an `object` command for the box named in `CACHE_OBJECTS_BOX`, sent
 * from the service call, which must be control-verified (checked here and again when the box leases it). The box
 * applies its own gates: remote transmit on (`BOX_TX=1`), its transmit switch, the service call sharing its
 * station's base call, the command's age and its token bucket (txlimit.ts). Nothing is sent while the box has
 * not polled lately, cannot transmit on RF or reports no position, or while an earlier object is uncollected.
 * Cache objects never go to APRS-IS from the gateway: IGates near the box gate what they hear, as for any station.
 *
 * Heard back, over RF or APRS-IS, an object is never the sender's position (ingest.ts `fixOf`), so it is no find
 * evidence.
 */
import { baseCall, haversineMeters, isAprsObjectName, rfClip } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { setting } from "./siteconfig.js";
import { serviceCall } from "./servicecall.js";
import { isCallsignVerified } from "./callsign.js";
import { freshBoxCaps, systemObjectCommand } from "./box.js";
import { nowS } from "./util/time.js";

/** The first repeat of a new or changed object; each later one doubles it, up to the slow rate. */
const DECAY_START_S = 5 * 60;
/** How often a killed object goes out before it is forgotten. */
export const KILL_SENDS = 3;
/** The most caches on air at once, the nearest first. */
const MAX_ON_AIR = 25;
/** The bytes of a cache title an object's comment carries. */
const COMMENT_BYTES = 36;

/** What the scheduler sends, from the site settings. */
interface CacheObjectsConfig {
  on: boolean;
  box: string;
  radiusKm: number;
  intervalS: number;
  perRun: number;
  path: string[];
}

const intIn = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

export function cacheObjectsConfig(env: Env): CacheObjectsConfig {
  const flag = (setting(env, "CACHE_OBJECTS") ?? "0").trim().toLowerCase();
  return {
    on: flag === "1" || flag === "true" || flag === "yes",
    box: (setting(env, "CACHE_OBJECTS_BOX") ?? "").trim(),
    radiusKm: intIn(setting(env, "CACHE_OBJECTS_RADIUS_KM"), 20, 1, 50),
    intervalS: intIn(setting(env, "CACHE_OBJECTS_INTERVAL_MIN"), 30, 30, 240) * 60,
    perRun: intIn(setting(env, "CACHE_OBJECTS_PER_RUN"), 2, 1, 5),
    path: setting(env, "CACHE_OBJECTS_PATH") === "WIDE1-1" ? ["WIDE1-1"] : [],
  };
}

/** One object as the instance keeps it (`cache_objects`). */
export interface ObjectRow {
  name: string;
  lat: number;
  lon: number;
  comment: string;
  alive: number;
  sends: number;
  last_sent: number | null;
}

/** A cache that should be on air. */
interface WantedObject {
  name: string;
  lat: number;
  lon: number;
  comment: string;
}

/** What one run does: the objects to send, the rows to write and the rows to forget. */
interface ObjectPlan {
  send: { name: string; lat: number; lon: number; comment: string; alive: boolean }[];
  upsert: ObjectRow[];
  remove: string[];
}

/** Seconds after its last send that an object is due again, by its state and how often it went out in it. */
function dueAfter(row: ObjectRow, intervalS: number): number {
  if (row.sends === 0) return 0;
  const decay = DECAY_START_S * 2 ** (row.sends - 1);
  return row.alive ? Math.min(intervalS, decay) : decay;
}

/**
 * Plan one run: compare what is on air with what should be, and pick the objects due now, kills first, then the
 * ones announced least, then the longest unsent. Pure, so the decay, the kills and the rate are tested apart
 * from the database.
 */
export function planCacheObjects(
  rows: ObjectRow[],
  wanted: WantedObject[],
  now: number,
  cfg: Pick<CacheObjectsConfig, "intervalS" | "perRun">,
): ObjectPlan {
  const plan: ObjectPlan = { send: [], upsert: [], remove: [] };
  const want = new Map(wanted.map((w) => [w.name, w]));
  const next: ObjectRow[] = [];
  for (const r of rows) {
    const w = want.get(r.name);
    if (w) {
      const same = r.alive === 1 && r.lat === w.lat && r.lon === w.lon && r.comment === w.comment;
      // a new state starts the decay again
      next.push(same ? r : { ...r, ...w, alive: 1, sends: 0 });
    } else if (r.alive === 1 && r.last_sent === null)
      plan.remove.push(r.name); // never on air: nothing to kill
    else if (r.alive === 1) next.push({ ...r, alive: 0, sends: 0 });
    else if (r.sends >= KILL_SENDS) plan.remove.push(r.name);
    else next.push(r);
  }
  const known = new Set(rows.map((r) => r.name));
  for (const w of wanted) if (!known.has(w.name)) next.push({ ...w, alive: 1, sends: 0, last_sent: null });

  const due = next
    .filter((r) => r.last_sent === null || now - r.last_sent >= dueAfter(r, cfg.intervalS))
    .sort((a, b) => a.alive - b.alive || a.sends - b.sends || (a.last_sent ?? 0) - (b.last_sent ?? 0));
  const sending = new Set(due.slice(0, cfg.perRun));
  for (const r of next) {
    if (sending.has(r)) {
      plan.send.push({ name: r.name, lat: r.lat, lon: r.lon, comment: r.comment, alive: r.alive === 1 });
      plan.upsert.push({ ...r, sends: r.sends + 1, last_sent: now });
    } else if (!rows.includes(r)) plan.upsert.push(r);
  }
  return plan;
}

/** The caches within `radiusKm` of the box, nearest first: native, active, public, never a living cache. */
async function wantedNear(env: Env, at: { lat: number; lon: number }, radiusKm: number): Promise<WantedObject[]> {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.01, Math.cos((at.lat * Math.PI) / 180)));
  const rows = (
    await env.DB.prepare(
      `SELECT code, title, lat, lon FROM caches
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
          AND status = 'active' AND removed_at IS NULL AND source = 'native' AND fed_scope = 'public'
          AND type != 'aprs_living' AND lat IS NOT NULL AND lon IS NOT NULL`,
    )
      .bind(at.lat - dLat, at.lat + dLat, at.lon - dLon, at.lon + dLon)
      .all<{ code: string; title: string; lat: number; lon: number }>()
  ).results;
  return rows
    .map((c) => ({ c, m: haversineMeters(at.lat, at.lon, c.lat, c.lon) }))
    .filter(({ c, m }) => m <= radiusKm * 1000 && isAprsObjectName(c.code))
    .sort((a, b) => a.m - b.m)
    .slice(0, MAX_ON_AIR)
    .map(({ c }) => ({
      name: c.code,
      lat: c.lat,
      lon: c.lon,
      comment: rfClip(c.title.replace(/[\r\n\x00-\x1f\x7f|~]/g, " ").trim(), COMMENT_BYTES),
    }));
}

/** Why a run sent nothing, or how many objects it queued. */
type CacheObjectsResult = { queued: number } | { skipped: string };

/** May this box transmit for the instance? A box enrolled with its own key must run the instance's services. */
async function boxMayServe(env: Env, box: string): Promise<boolean> {
  const k = await env.DB.prepare("SELECT services, revoked_at FROM box_keys WHERE box_id = ?")
    .bind(box)
    .first<{ services: number; revoked_at: number | null }>();
  return !k || (k.revoked_at == null && k.services === 1);
}

/** One run of the scheduler (every five minutes): queue the objects due now for the transmitting box. */
export async function runCacheObjects(env: Env, now = nowS()): Promise<CacheObjectsResult> {
  const cfg = cacheObjectsConfig(env);
  if (!cfg.on) return { skipped: "off" };
  if (!cfg.box) return { skipped: "no transmitting box set" };
  const caps = await freshBoxCaps(env, cfg.box);
  if (!caps?.tx || !caps.rf || !caps.pos) return { skipped: "the box cannot transmit on RF, or reports no position" };
  if (!(await boxMayServe(env, cfg.box))) return { skipped: "the box does not run this instance's services" };
  const call = serviceCall(env);
  if (!(await isCallsignVerified(env, baseCall(call)))) return { skipped: `${call} is not control-verified` };
  // one batch at a time: a box that has not collected the last one gets no more
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM box_commands WHERE box_id = ? AND kind = 'object' AND status = 'queued'",
  )
    .bind(cfg.box)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) > 0) return { skipped: "earlier objects are not collected yet" };

  const rows = (await env.DB.prepare("SELECT * FROM cache_objects").all<ObjectRow>()).results;
  const plan = planCacheObjects(rows, await wantedNear(env, caps.pos, cfg.radiusKm), now, cfg);
  const stmts = [
    ...plan.remove.map((n) => env.DB.prepare("DELETE FROM cache_objects WHERE name = ?").bind(n)),
    ...plan.upsert.map((r) =>
      env.DB.prepare(
        `INSERT INTO cache_objects (name, lat, lon, comment, alive, sends, last_sent) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, comment=excluded.comment,
           alive=excluded.alive, sends=excluded.sends, last_sent=excluded.last_sent`,
      ).bind(r.name, r.lat, r.lon, r.comment, r.alive, r.sends, r.last_sent),
    ),
    ...plan.send.map((o) => systemObjectCommand(env, cfg.box, call, { ...o, path: cfg.path })),
  ];
  if (stmts.length) await env.DB.batch(stmts);
  return { queued: plan.send.length };
}
