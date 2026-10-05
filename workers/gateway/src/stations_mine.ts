// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * stations_mine.ts — the operator's own stations registry. A signed-in user
 * manages many stations: a home PWS, a mountain-top digipeater / igate / node — each with its own
 * callsign+SSID, an explicit location, a description and roles. Weather is one role; a weather-capable
 * station carries its own PWS push key, issued when the station is added. Stations fold into the existing
 * GDPR export/erase.
 *
 *   GET    /api/my/stations              list my stations (keyset-paginated)
 *   POST   /api/my/stations              create { callsign, lat?, lon?, symbol?, description?, roles[] } (+ wx key)
 *   PATCH  /api/my/stations/:id          update any field
 *   DELETE /api/my/stations/:id          remove (and its PWS key)
 *   GET    /api/my/stations/:id/wx-key   read the station's PWS key + URLs
 *   POST   /api/my/stations/:id/wx-key   (re)issue the station's PWS key (weather role required)
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json, asStr } from "./app.js";
import { sessionIdentity, baseHolder } from "./auth.js";
import { requireSysop } from "./admin.js";
import { sanitizeBio } from "./profile.js";
import { makeWxKey, wxUrls, homeLocatorPosition } from "./wx.js";
import { isCallsignVerified } from "./callsign.js";
import { handleCreateCache } from "./caches.js";
import { parsePage, keyset, paginate } from "./paging.js";
import { STATION_ROLES, type StationRole, type OperatedStation, type StationWxKey } from "@aprscaching/shared";

const CALLSIGN_RE = /^[A-Z0-9]{1,7}(-[0-9]{1,2})?$/; // base call + optional SSID

/** Is this a syntactically valid station callsign (base + optional SSID)? Case-insensitive. */
export const validStationCallsign = (cs: string): boolean => CALLSIGN_RE.test(cs.trim().toUpperCase());

interface StationRow {
  id: number;
  account_id: string;
  callsign: string;
  lat: number | null;
  lon: number | null;
  symbol: string | null;
  description: string | null;
  roles: string;
  created_at: number;
  updated_at: number;
}

export function parseRoles(raw: unknown): StationRole[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<StationRole>();
  for (const r of arr) {
    const v = String(r).trim().toLowerCase();
    if ((STATION_ROLES as readonly string[]).includes(v)) seen.add(v as StationRole);
  }
  return [...seen];
}

function toStation(r: StationRow): OperatedStation {
  return {
    id: r.id,
    callsign: r.callsign,
    lat: r.lat,
    lon: r.lon,
    symbol: r.symbol,
    description: r.description,
    roles: parseRoles(r.roles),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Validate an optional coordinate; returns {ok,value} where value is a number or null. */
function coord(v: unknown, lo: number, hi: number): { ok: boolean; value: number | null } {
  if (v == null || v === "") return { ok: true, value: null };
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? { ok: true, value: n } : { ok: false, value: null };
}

/** A sensible APRS map symbol for a station's primary role (so non-web clients show it sanely too). */
function symbolForRoles(roles: StationRole[], explicit?: string | null): string {
  if (explicit) return explicit;
  if (roles.includes("weather")) return "_"; // weather station
  if (roles.includes("digipeater")) return "#"; // digipeater
  if (roles.includes("igate")) return "&"; // gateway / IGate
  if (roles.includes("node")) return "I"; // network node (TCP/IP)
  if (roles.includes("repeater")) return "r"; // repeater
  return "/"; // generic
}

/** Place (or refresh) a registry station on the live map. `clobber=false` won't overwrite a station
 *  already beaconing on RF (adopt keeps its live fix); `true` lets an explicit edit move the pin. */
async function placeOnMap(
  env: Env,
  callsign: string,
  lat: number,
  lon: number,
  symbol: string,
  clobber: boolean,
): Promise<void> {
  const conflict = clobber
    ? "ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, symbol=excluded.symbol, last_seen=excluded.last_seen"
    : "ON CONFLICT(callsign) DO NOTHING";
  await env.DB.prepare(
    `INSERT INTO stations (callsign, lat, lon, last_seen, symbol, source_call) VALUES (?,?,?,?,?,?) ${conflict}`,
  )
    .bind(callsign, lat, lon, nowS(), symbol, callsign)
    .run();
}

/** A station whose only role is weather: platform-only ingest, which needs no licence and transmits nothing. */
const weatherOnly = (roles: StationRole[]): boolean => roles.length === 1 && roles[0] === "weather";

/**
 * Why this account may not list a station, or null when it may: a station belongs to a callsign the account holds
 * and has verified (OE8APR-9 needs OE8APR, held and verified), so nobody lists another operator's station and, from
 * it, a living cache that follows them. A weather-only station needs the call held, not yet verified: pushing
 * weather to the platform needs no licence, and its beacon and CWOP relay stay gated on verification. A club's
 * station is listed by an account holding the club call, or by the sysop for a member (POST /api/admin/stations).
 */
async function stationRefusal(env: Env, acct: string, callsign: string, roles: StationRole[]): Promise<string | null> {
  if (!CALLSIGN_RE.test(callsign)) return null; // not a callsign at all: addStation's check answers that
  const base = baseCall(callsign);
  if ((await baseHolder(env, base)) !== acct)
    return `${base} is not a callsign on your account: add it under Settings → Account, or ask your sysop to list the station for you`;
  if (!weatherOnly(roles) && !(await isCallsignVerified(env, base)))
    return `verify ${base} first: only a verified callsign's stations are listed (a weather-only station needs no verification)`;
  return null;
}

/** The account's home locator as a position, rounded to its 6-character square, or null when it has none. */
async function homePosition(env: Env, acct: string): Promise<{ lat: number; lon: number } | null> {
  const row = await env.DB.prepare(
    "SELECT home_grid AS homeGrid FROM accounts WHERE account_id = ? AND home_grid IS NOT NULL LIMIT 1",
  )
    .bind(acct)
    .first<{ homeGrid: string }>();
  return row ? homeLocatorPosition(row.homeGrid) : null;
}

/** Issue (or re-issue) a weather station's push key, replacing any earlier one. */
async function issueStationKey(env: Env, acct: string, station: StationRow): Promise<void> {
  await env.DB.prepare("DELETE FROM wx_keys WHERE station_id = ?").bind(station.id).run();
  await env.DB.prepare("INSERT INTO wx_keys (key, callsign, account_id, station_id, created_at) VALUES (?,?,?,?,?)")
    .bind(makeWxKey(), baseCall(station.callsign), acct, station.id, nowS())
    .run();
}

/** A station's weather push key with its ready-to-paste URLs and TX switches. */
async function stationWxKey(env: Env, origin: string, station: StationRow): Promise<StationWxKey> {
  const key = await env.DB.prepare(
    "SELECT key, last_seen AS lastSeen, tx_is AS txIs, tx_cwop AS txCwop FROM wx_keys WHERE station_id = ?",
  )
    .bind(station.id)
    .first<{ key: string; lastSeen: number | null; txIs: number; txCwop: number }>();
  const urls = key ? wxUrls(origin, station.callsign, key.key) : null;
  return {
    key: key?.key ?? null,
    lastSeen: key?.lastSeen ?? null,
    ecowittPath: urls?.ecowittPath ?? null,
    wuUrl: urls?.wuUrl ?? null,
    txIs: !!key?.txIs,
    txCwop: !!key?.txCwop,
    verified: await isCallsignVerified(env, baseCall(station.callsign)),
  };
}

/** Add a station to an account's registry: the checks every way in shares, then the row and its map entry. */
async function addStation(env: Env, acct: string, b: Record<string, unknown>, origin: string): Promise<Response> {
  const callsign = asStr(b.callsign).trim().toUpperCase();
  if (!CALLSIGN_RE.test(callsign))
    return json({ error: "enter a valid callsign (optionally with an SSID, e.g. OE8APR-1)" }, { status: 400 });
  // a given callsign lives in one operator's registry
  const taken = await env.DB.prepare("SELECT account_id FROM account_stations WHERE callsign = ?")
    .bind(callsign)
    .first<{ account_id: string }>();
  if (taken) return json({ error: `${callsign} is already registered` }, { status: 409 });
  const lat = coord(b.lat, -90, 90),
    lon = coord(b.lon, -180, 180);
  if (!lat.ok || !lon.ok) return json({ error: "latitude must be -90..90 and longitude -180..180" }, { status: 400 });
  const roles = parseRoles(b.roles);
  const symbol = typeof b.symbol === "string" && b.symbol.trim() ? b.symbol.trim().slice(0, 2) : null;
  const description = sanitizeBio(b.description);

  // Location is required at creation. If omitted, adopt the live fix of a station already heard on
  // the map (the "pick an existing station" path); a weather station falls back to the home locator — else ask.
  let latV = lat.value,
    lonV = lon.value,
    adopted = false;
  if (latV == null || lonV == null) {
    const heard = await env.DB.prepare("SELECT lat, lon FROM stations WHERE callsign = ?")
      .bind(callsign)
      .first<{ lat: number | null; lon: number | null }>();
    const home = heard?.lat != null || !roles.includes("weather") ? null : await homePosition(env, acct);
    if (heard?.lat != null && heard.lon != null) {
      latV = heard.lat;
      lonV = heard.lon;
      adopted = true;
    } else if (home) {
      latV = home.lat;
      lonV = home.lon;
    } else
      return json(
        {
          error: roles.includes("weather")
            ? "set a location, or a home locator under Settings → Profile"
            : "set a location, or pick a station that has already been heard on the map",
        },
        { status: 400 },
      );
  }

  const sym = symbolForRoles(roles, symbol);
  const ts = nowS();
  const ins = await env.DB.prepare(
    "INSERT INTO account_stations (account_id, callsign, lat, lon, symbol, description, roles, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(acct, callsign, latV, lonV, sym, description, roles.join(","), ts, ts)
    .run();
  // Place it on the live map. Adopting keeps the heard station's own fix/symbol; a fresh station is
  // pinned at the given coords with its role symbol. APRS beacons update it from here (ingest.ts).
  await placeOnMap(env, callsign, latV, lonV, sym, !adopted);
  const row = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?")
    .bind(ins.meta.last_row_id)
    .first<StationRow>();
  // a weather station gets its push key at once, so its URLs show the moment it is added
  if (!roles.includes("weather")) return json({ station: toStation(row!) }, { status: 201 });
  await issueStationKey(env, acct, row!);
  return json({ station: { ...toStation(row!), wx: await stationWxKey(env, origin, row!) } }, { status: 201 });
}

/**
 * POST /api/admin/stations — the sysop lists a station for a member: `{ owner, callsign, lat?, lon?, roles?, … }`,
 * where `owner` is any callsign the member's account holds. For a club station run by a member who does not hold
 * the club call; the member then manages it under My stations like their own.
 */
export async function handleAdminAddStation(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return json({ error: "bad request" }, { status: 400 });
  const owner = baseCall(asStr(b.owner).trim().toUpperCase());
  const acct = owner ? await baseHolder(env, owner) : null;
  if (!acct) return json({ error: `no account holds ${owner || "that callsign"}` }, { status: 404 });
  return addStation(env, acct, b, new URL(req.url).origin);
}

export async function handleMyStations(req: Request, env: Env): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });

  if (req.method === "POST") {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return json({ error: "bad request" }, { status: 400 });
    const refused = await stationRefusal(env, acct, asStr(b.callsign).trim().toUpperCase(), parseRoles(b.roles));
    if (refused) return json({ error: refused }, { status: 403 });
    return addStation(env, acct, b, new URL(req.url).origin);
  }

  const pg = parsePage(new URL(req.url), 50, 200);
  const ks = keyset(pg.cursor, "id", "id"); // simple id-keyset; one ordering column suffices here
  const rows = (
    await env.DB.prepare(`SELECT * FROM account_stations WHERE account_id = ?${ks.sql} ORDER BY id DESC LIMIT ?`)
      .bind(acct, ...ks.binds, pg.limit + 1)
      .all<StationRow>()
  ).results;
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.id, id: r.id }));
  // the living caches riding these stations, so the list turns their rendezvous logging on and off in place;
  // a living cache rides only a station its hider operates, so every one here is the caller's
  const calls = page.items.map((r) => r.callsign.toUpperCase());
  const living = calls.length
    ? (
        await env.DB.prepare(
          `SELECT id, code, title, station_call, rendezvous FROM caches
           WHERE type = 'aprs_living' AND status != 'archived' AND UPPER(station_call) IN (${calls.map(() => "?").join(",")})
           ORDER BY id`,
        )
          .bind(...calls)
          .all<{ id: number; code: string; title: string; station_call: string; rendezvous: number | null }>()
      ).results
    : [];
  const stations = page.items.map((r) => {
    const mine = living.filter((c) => c.station_call.toUpperCase() === r.callsign.toUpperCase());
    return {
      ...toStation(r),
      ...(mine.length && {
        livingCaches: mine.map((c) => ({ id: c.id, code: c.code, title: c.title, rendezvous: !!c.rendezvous })),
      }),
    };
  });
  return json({ stations, nextCursor: page.nextCursor, hasMore: page.hasMore });
}

/** Load a station the caller owns, or null (404/403 handled by callers). */
async function ownedStation(env: Env, acct: string, id: number): Promise<StationRow | null> {
  const row = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?").bind(id).first<StationRow>();
  if (!row || row.account_id !== acct) return null;
  return row;
}

/** GET / PATCH / DELETE a single station. */
export async function handleMyStation(req: Request, env: Env, id: number): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });
  const row = await ownedStation(env, acct, id);
  if (!row) return json({ error: "no such station" }, { status: 404 });

  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM wx_keys WHERE station_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM account_stations WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (req.method === "PATCH" || req.method === "PUT") {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) return json({ error: "bad request" }, { status: 400 });
    const lat = coord(b.lat, -90, 90),
      lon = coord(b.lon, -180, 180);
    if (("lat" in b && !lat.ok) || ("lon" in b && !lon.ok))
      return json({ error: "latitude must be -90..90 and longitude -180..180" }, { status: 400 });
    const roles = "roles" in b ? parseRoles(b.roles) : parseRoles(row.roles);
    // a role beyond weather needs the station's base call verified, as listing such a station does
    const had = parseRoles(row.roles);
    const base = baseCall(row.callsign);
    if (roles.some((r) => r !== "weather" && !had.includes(r)) && !(await isCallsignVerified(env, base)))
      return json({ error: `verify ${base} first: roles beyond weather need a verified callsign` }, { status: 403 });
    const explicitSym =
      "symbol" in b
        ? typeof b.symbol === "string" && b.symbol.trim()
          ? b.symbol.trim().slice(0, 2)
          : null
        : row.symbol;
    const next = {
      lat: "lat" in b ? lat.value : row.lat,
      lon: "lon" in b ? lon.value : row.lon,
      symbol: symbolForRoles(roles, explicitSym),
      description: "description" in b ? sanitizeBio(b.description) : row.description,
      roles: roles.join(","),
    };
    await env.DB.prepare(
      "UPDATE account_stations SET lat=?, lon=?, symbol=?, description=?, roles=?, updated_at=? WHERE id=?",
    )
      .bind(next.lat, next.lon, next.symbol, next.description, next.roles, nowS(), id)
      .run();
    // Reflect an explicit edit on the map (moves the pin / updates the role glyph). Live RF beacons
    // continue to override this from ingest.
    if (next.lat != null && next.lon != null)
      await placeOnMap(env, row.callsign, next.lat, next.lon, next.symbol, true);
    const updated = await env.DB.prepare("SELECT * FROM account_stations WHERE id = ?").bind(id).first<StationRow>();
    return json({ station: toStation(updated!) });
  }
  return json({ station: toStation(row) });
}

/** GET / POST the weather PWS key for a weather-capable station. */
export async function handleStationWxKey(req: Request, env: Env, id: number): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in to manage your stations" }, { status: 401 });
  const row = await ownedStation(env, acct, id);
  if (!row) return json({ error: "no such station" }, { status: 404 });
  if (!parseRoles(row.roles).includes("weather"))
    return json({ error: "give this station the weather role first" }, { status: 400 });

  if (req.method === "POST") await issueStationKey(env, acct, row);
  return json(await stationWxKey(env, new URL(req.url).origin, row));
}

/** Delegate to the canonical create path, preserving the caller's session so actor() owns the cache. */
function createVia(req: Request, env: Env, body: Record<string, unknown>): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const secret = req.headers.get("x-ingest-secret");
  if (secret) headers.set("x-ingest-secret", secret);
  const r = new Request(`${new URL(req.url).origin}/api/caches`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handleCreateCache(r, env);
}

/**
 * POST /api/my/stations/:id/cache — turn an operated station into an APRScache at its location
 *. A single cache by default; `{ living: true }` makes it an aprs_living cache that follows
 * the station's beacon. Owned by the signed-in operator.
 */
export async function handleStationToCache(req: Request, env: Env, id: number): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in to make a cache" }, { status: 401 });
  const row = await ownedStation(env, acct, id);
  if (!row) return json({ error: "no such station" }, { status: 404 });
  if (row.lat == null || row.lon == null) return json({ error: "give the station a location first" }, { status: 400 });
  // a weather-only station may sit on a call not yet verified; a cache at it waits for that verification
  const base = baseCall(row.callsign);
  if ((await baseHolder(env, base)) === acct && !(await isCallsignVerified(env, base)))
    return json(
      { error: `verify ${base} first: a station becomes a cache once its callsign is verified` },
      { status: 403 },
    );
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const living = b.living === true || b.type === "aprs_living";
  const title =
    typeof b.title === "string" && b.title.trim()
      ? b.title.trim().slice(0, 120)
      : `${row.callsign}${row.description ? ` — ${row.description}` : ""}`.slice(0, 120);
  return createVia(req, env, {
    title,
    type: living ? "aprs_living" : "traditional",
    lat: row.lat,
    lon: row.lon,
    ...(living ? { stationCall: row.callsign } : {}),
    ...(typeof b.difficulty === "number" ? { difficulty: b.difficulty } : {}),
    ...(typeof b.terrain === "number" ? { terrain: b.terrain } : {}),
    ...(typeof b.description === "string"
      ? { description: b.description }
      : row.description
        ? { description: row.description }
        : {}),
  });
}

/**
 * POST /api/me/cache — "become a cache": an aprs_living cache that follows the operator's
 * own beacon. Placed at their latest beacon fix, else their home locator's 6-character square. stationCall is the most recent
 * SSID heard (so the living-cache match works), else the base call.
 */
export async function handleMeCache(req: Request, env: Env): Promise<Response> {
  const cs = (await sessionIdentity(req, env))?.callsign ?? null;
  if (!cs) return json({ error: "sign in to put yourself on the map" }, { status: 401 });
  const base = baseCall(cs);
  const beacon = await env.DB.prepare(
    "SELECT callsign, lat, lon FROM positions WHERE callsign = ? OR callsign LIKE ? ORDER BY ts DESC LIMIT 1",
  )
    .bind(base, `${base}-%`)
    .first<{ callsign: string; lat: number; lon: number }>();
  let lat = beacon?.lat ?? null,
    lon = beacon?.lon ?? null;
  const stationCall = beacon?.callsign ?? base;
  if (lat == null) {
    const acct = await env.DB.prepare("SELECT home_grid AS homeGrid FROM accounts WHERE callsign = ?")
      .bind(base)
      .first<{ homeGrid: string | null }>();
    const ll = acct?.homeGrid ? homeLocatorPosition(acct.homeGrid) : null;
    if (ll) {
      lat = ll.lat;
      lon = ll.lon;
    }
  }
  if (lat == null || lon == null)
    return json({ error: "set a home locator (Settings → Profile) or beacon on APRS first" }, { status: 400 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 120) : `${base} (live)`;
  // a living cache follows one of the account's own stations: the beacon it follows joins My stations
  const acct = (await sessionIdentity(req, env))!.accountId;
  const listed = await env.DB.prepare("SELECT account_id FROM account_stations WHERE callsign = ?")
    .bind(stationCall)
    .first<{ account_id: string }>();
  if (listed && listed.account_id !== acct)
    return json({ error: `${stationCall} is registered to another operator's stations` }, { status: 409 });
  if (!listed) {
    const refused = await stationRefusal(env, acct, stationCall, []);
    if (refused) return json({ error: refused }, { status: 403 });
    const now = nowS();
    await env.DB.prepare(
      "INSERT INTO account_stations (account_id, callsign, lat, lon, roles, created_at, updated_at) VALUES (?,?,?,?, '', ?,?)",
    )
      .bind(acct, stationCall, lat, lon, now, now)
      .run();
  }
  return createVia(req, env, { title, type: "aprs_living", stationCall, lat, lon });
}
