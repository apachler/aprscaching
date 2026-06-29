/**
 * stations_mine.ts — the operator's own stations registry (docs/13 M5 + docs/17). A signed-in user
 * manages many stations: a home PWS, a mountain-top digipeater / igate / node — each with its own
 * callsign+SSID, an explicit location, a description and roles. Weather is one role; a weather-capable
 * station carries its own PWS push key. Stations fold into the existing GDPR export/erase.
 *
 *   GET    /api/my/stations              list my stations (keyset-paginated)
 *   POST   /api/my/stations              create { callsign, lat?, lon?, symbol?, description?, roles[] }
 *   PATCH  /api/my/stations/:id          update any field
 *   DELETE /api/my/stations/:id          remove (and its PWS key)
 *   GET    /api/my/stations/:id/wx-key   read the station's PWS key + URLs
 *   POST   /api/my/stations/:id/wx-key   (re)issue the station's PWS key (weather role required)
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./watch.js";
import { sanitizeBio } from "./profile.js";
import { makeWxKey, wxUrls } from "./wx.js";
import { parsePage, keyset, paginate } from "./paging.js";
import { STATION_ROLES, type StationRole, type OperatedStation } from "@aprsweb/shared";

const now = () => Math.floor(Date.now() / 1000);
const CALLSIGN_RE = /^[A-Z0-9]{1,7}(-[0-9]{1,2})?$/;   // base call + optional SSID

/** Is this a syntactically valid station callsign (base + optional SSID)? Case-insensitive. */
export const validStationCallsign = (cs: string): boolean => CALLSIGN_RE.test(cs.trim().toUpperCase());

interface StationRow { id: number; account_id: string; callsign: string; lat: number | null; lon: number | null; symbol: string | null; description: string | null; roles: string; created_at: number; updated_at: number }

export function parseRoles(raw: unknown): StationRole[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<StationRole>();
  for (const r of arr) { const v = String(r).trim().toLowerCase(); if ((STATION_ROLES as readonly string[]).includes(v)) seen.add(v as StationRole); }
  return [...seen];
}

function toStation(r: StationRow): OperatedStation {
  return {
    id: r.id, callsign: r.callsign, lat: r.lat, lon: r.lon, symbol: r.symbol,
    description: r.description, roles: parseRoles(r.roles), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Validate an optional coordinate; returns {ok,value} where value is a number or null. */
function coord(v: unknown, lo: number, hi: number): { ok: boolean; value: number | null } {
  if (v == null || v === "") return { ok: true, value: null };
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? { ok: true, value: n } : { ok: false, value: null };
}

/** GET list / POST create. */
export async function handleMyStations(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });

  if (req.method === "POST") {
    const b = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!b) return json({ error: "bad request" }, { status: 400 });
    const callsign = String(b.callsign ?? "").trim().toUpperCase();
    if (!CALLSIGN_RE.test(callsign)) return json({ error: "enter a valid callsign (optionally with an SSID, e.g. OE8APR-1)" }, { status: 400 });
    const base = callsign.split("-")[0]!;
    // anti-impersonation: you may only register stations under a base call your account holds.
    const held = await env.DB.prepare("SELECT 1 AS ok FROM account_callsigns WHERE account_id = ? AND callsign = ?").bind(acct, base).first<{ ok: number }>();
    if (!held) return json({ error: `add ${base} to your account first (Settings → Account) before registering its stations` }, { status: 403 });
    const taken = await env.DB.prepare("SELECT account_id FROM account_stations WHERE callsign = ?").bind(callsign).first<{ account_id: string }>();
    if (taken) return json({ error: `${callsign} is already registered` }, { status: 409 });
    const lat = coord(b.lat, -90, 90), lon = coord(b.lon, -180, 180);
    if (!lat.ok || !lon.ok) return json({ error: "latitude must be -90..90 and longitude -180..180" }, { status: 400 });
    const roles = parseRoles(b.roles);
    const symbol = typeof b.symbol === "string" && b.symbol.trim() ? b.symbol.trim().slice(0, 2) : null;
    const description = sanitizeBio(b.description);
    const ts = now();
    const ins = await env.DB.prepare(
      "INSERT INTO account_stations (account_id, callsign, lat, lon, symbol, description, roles, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(acct, callsign, lat.value, lon.value, symbol, description, roles.join(","), ts, ts).run();
    const row = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?").bind(ins.meta.last_row_id).first<StationRow>();
    return json({ station: toStation(row!) }, { status: 201 });
  }

  const pg = parsePage(new URL(req.url), 50, 200);
  const ks = keyset(pg.cursor, "id", "id");   // simple id-keyset; one ordering column suffices here
  const rows = (await env.DB.prepare(
    `SELECT * FROM account_stations WHERE account_id = ?${ks.sql} ORDER BY id DESC LIMIT ?`,
  ).bind(acct, ...ks.binds, pg.limit + 1).all<StationRow>()).results;
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.id, id: r.id }));
  return json({ stations: page.items.map(toStation), nextCursor: page.nextCursor, hasMore: page.hasMore });
}

/** Load a station the caller owns, or null (404/403 handled by callers). */
async function ownedStation(env: Env, acct: string, id: number): Promise<StationRow | null> {
  const row = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?").bind(id).first<StationRow>();
  if (!row || row.account_id !== acct) return null;
  return row;
}

/** GET / PATCH / DELETE a single station. */
export async function handleMyStation(req: Request, env: Env, id: number): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });
  const row = await ownedStation(env, acct, id);
  if (!row) return json({ error: "no such station" }, { status: 404 });

  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM wx_keys WHERE station_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM account_stations WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (req.method === "PATCH" || req.method === "PUT") {
    const b = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!b) return json({ error: "bad request" }, { status: 400 });
    const lat = coord(b.lat, -90, 90), lon = coord(b.lon, -180, 180);
    if (("lat" in b && !lat.ok) || ("lon" in b && !lon.ok)) return json({ error: "latitude must be -90..90 and longitude -180..180" }, { status: 400 });
    const next = {
      lat: "lat" in b ? lat.value : row.lat,
      lon: "lon" in b ? lon.value : row.lon,
      symbol: "symbol" in b ? (typeof b.symbol === "string" && b.symbol.trim() ? b.symbol.trim().slice(0, 2) : null) : row.symbol,
      description: "description" in b ? sanitizeBio(b.description) : row.description,
      roles: "roles" in b ? parseRoles(b.roles).join(",") : row.roles,
    };
    await env.DB.prepare(
      "UPDATE account_stations SET lat=?, lon=?, symbol=?, description=?, roles=?, updated_at=? WHERE id=?",
    ).bind(next.lat, next.lon, next.symbol, next.description, next.roles, now(), id).run();
    const updated = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?").bind(id).first<StationRow>();
    return json({ station: toStation(updated!) });
  }
  return json({ station: toStation(row) });
}

/** GET / POST the weather PWS key for a weather-capable station. */
export async function handleStationWxKey(req: Request, env: Env, id: number): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });
  const row = await ownedStation(env, acct, id);
  if (!row) return json({ error: "no such station" }, { status: 404 });
  if (!parseRoles(row.roles).includes("weather")) return json({ error: "give this station the weather role first" }, { status: 400 });

  const base = row.callsign.split("-")[0]!;
  if (req.method === "POST") {
    await env.DB.prepare("DELETE FROM wx_keys WHERE station_id = ?").bind(id).run();
    await env.DB.prepare("INSERT INTO wx_keys (key, callsign, account_id, station_id, created_at) VALUES (?,?,?,?,?)")
      .bind(makeWxKey(), base, acct, id, now()).run();
  }
  const key = await env.DB.prepare("SELECT key, last_seen AS lastSeen FROM wx_keys WHERE station_id = ?").bind(id).first<{ key: string; lastSeen: number | null }>();
  const urls = key ? wxUrls(new URL(req.url).origin, row.callsign, key.key) : null;
  return json({ key: key?.key ?? null, lastSeen: key?.lastSeen ?? null, ecowittPath: urls?.ecowittPath ?? null, wuUrl: urls?.wuUrl ?? null });
}
