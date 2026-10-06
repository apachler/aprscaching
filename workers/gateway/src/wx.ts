// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * wx.ts — weather user-origination. A personal weather station pushes directly to the
 * platform with the push key of one of the operator's weather-role stations (My stations); the reading is
 * stored in sensor_readings under that station's callsign. We
 * speak the formats consumer stations already emit (Ecowitt "customized" HTTP push + Weather
 * Underground "Rapidfire" GET), so most stations work by just pointing them at the URL with a key.
 * Platform-only ingest carries NO RF-licence implication (the licence gate is only for TX/CWOP).
 *
 *   GET/POST /api/wx/submit              push a reading (?key=… ; or WU PASSWORD=key)
 *   GET/POST /api/wx/updateweatherstation  WU-Rapidfire alias
 *   POST     /api/wx/tx                  (session) a station's APRS-IS weather beacon / CWOP relay switches
 *
 * Keys are issued per station under /api/my/stations/:id/wx-key (stations_mine.ts).
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity } from "./auth.js";
import { gridToLatLon } from "@aprscaching/shared";
import { baseCall, encodeAprsWeather, type WxEncodeFields } from "@aprscaching/aprs";
import { isCallsignVerified } from "./callsign.js";
import { callSuspended, SUSPENDED_TEXT } from "./moderation.js";

const WX_BEACON_MIN_SEC = 300; // throttle WX beacons to ≤ once / 5 min (cost + APRS etiquette)

const num = (v: string | undefined): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const fToC = (f: number) => r1(((f - 32) * 5) / 9);
const inHgToHpa = (x: number) => r1(x * 33.8638867);
const mphToKn = (x: number) => r1(x * 0.868976);
const inToMm = (x: number) => r1(x * 25.4);

export interface WxReading {
  temp_c?: number;
  humidity?: number;
  pressure_hpa?: number;
  wind_dir?: number;
  wind_kn?: number;
  gust_kn?: number;
  rain_mm?: number;
  rain_24h_mm?: number;
  luminosity_wm2?: number;
}

/**
 * A home locator as a station position: the centre of its 6-character square (about 5 × 2.5 km), however
 * precise the stored locator is. A weather station without coordinates is placed here on the public map, and
 * the home locator itself stays as private as the profile keeps it.
 */
export const homeLocatorPosition = (grid: string): { lat: number; lon: number } | null =>
  gridToLatLon(grid.trim().slice(0, 6));

/** Parse an Ecowitt / WU parameter bag (imperial) into our metric reading. */
export function parseWx(get: (k: string) => string | undefined): WxReading {
  const g = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = num(get(k));
      if (v != null) return v;
    }
    return undefined;
  };
  const tempf = g("tempf", "temp"),
    barom = g("baromrelin", "baromin", "barom"),
    wind = g("windspeedmph", "windspeed");
  const gust = g("windgustmph", "windgust"),
    rainHr = g("hourlyrainin", "rainin"),
    rainDay = g("dailyrainin");
  const dir = g("winddir");
  return {
    temp_c: tempf != null ? fToC(tempf) : undefined,
    humidity: g("humidity"),
    pressure_hpa: barom != null ? inHgToHpa(barom) : undefined,
    wind_dir: dir != null ? Math.round(dir) % 360 : undefined,
    wind_kn: wind != null ? mphToKn(wind) : undefined,
    gust_kn: gust != null ? mphToKn(gust) : undefined,
    rain_mm: rainHr != null ? inToMm(rainHr) : undefined,
    rain_24h_mm: rainDay != null ? inToMm(rainDay) : undefined,
    luminosity_wm2: g("solarradiation"),
  };
}

/** How far back a station's own `dateutc` may date a reading: a late upload after a short outage. */
const WX_TIME_MAX_PAST_S = 24 * 3600;
/** How far ahead it may: clock skew, not a time that would stand as the station's latest for days. */
const WX_TIME_MAX_AHEAD_S = 5 * 60;

/**
 * The time a reading is stored under: the station's `dateutc` when it parses and lies within
 * [now − {@link WX_TIME_MAX_PAST_S}, now + {@link WX_TIME_MAX_AHEAD_S}], else the time it arrived. Pure.
 */
export function readingTime(dateutc: string | undefined, now: number): number {
  if (!dateutc || dateutc === "now") return now;
  const t = Date.parse(dateutc.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return now;
  const s = Math.floor(t / 1000);
  return s >= now - WX_TIME_MAX_PAST_S && s <= now + WX_TIME_MAX_AHEAD_S ? s : now;
}

/** Merge query params + (form/JSON) body into one getter; PWS pushes are usually GET or x-www-form. */
async function readParams(req: Request): Promise<(k: string) => string | undefined> {
  const url = new URL(req.url);
  const map = new Map<string, string>();
  for (const [k, v] of url.searchParams) map.set(k.toLowerCase(), v);
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const b = (await req.json()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(b)) map.set(k.toLowerCase(), String(v));
      } else {
        const t = await req.text();
        for (const [k, v] of new URLSearchParams(t)) map.set(k.toLowerCase(), v);
      }
    } catch {
      /* ignore */
    }
  }
  return (k) => map.get(k.toLowerCase());
}

/** GET/POST /api/wx/submit (+ /updateweatherstation) — store a PWS reading under its station. */
export async function handleWxSubmit(req: Request, env: Env): Promise<Response> {
  const get = await readParams(req);
  const key = get("key") ?? get("password"); // our key, or WU's PASSWORD field
  if (!key) return new Response("missing key", { status: 401 });
  const row = await env.DB.prepare(
    "SELECT callsign, station_id AS stationId FROM wx_keys WHERE key = ? AND station_id IS NOT NULL",
  )
    .bind(key)
    .first<{ callsign: string; stationId: number }>();
  if (!row) return new Response("unknown key", { status: 401 });
  // the key needs no session, so a suspended call's station is refused here: no reading, no beacon
  if (await callSuspended(env, row.callsign)) return new Response(SUSPENDED_TEXT, { status: 403 });

  const wx = parseWx(get);
  if (wx.temp_c == null && wx.humidity == null && wx.pressure_hpa == null && wx.wind_kn == null && wx.rain_mm == null)
    return new Response("no recognised weather fields", { status: 400 });

  // The reading lands under the key's station and sits at the station's own coordinates (a remote summit
  // PWS at its real location); a station without coordinates sits at its operator's home locator, rounded.
  const s = await env.DB.prepare(
    `SELECT s.callsign AS callsign, s.lat AS lat, s.lon AS lon,
            (SELECT a.home_grid FROM accounts a WHERE a.account_id = s.account_id AND a.home_grid IS NOT NULL LIMIT 1) AS homeGrid
       FROM account_stations s WHERE s.id = ?`,
  )
    .bind(row.stationId)
    .first<{ callsign: string; lat: number | null; lon: number | null; homeGrid: string | null }>();
  if (!s) return new Response("unknown key", { status: 401 });
  const station = s.callsign.toUpperCase();
  const place =
    s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : s.homeGrid ? homeLocatorPosition(s.homeGrid) : null;

  const ts = readingTime(get("dateutc"), nowS());
  const source = get("stationtype") || get("softwaretype") ? "ecowitt" : get("id") ? "wu" : "ecowitt";
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sensor_readings (station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, gust_kn, rain_mm, rain_24h_mm, luminosity_wm2, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      station,
      ts,
      wx.temp_c ?? null,
      wx.humidity ?? null,
      wx.pressure_hpa ?? null,
      wx.wind_dir ?? null,
      wx.wind_kn ?? null,
      wx.gust_kn ?? null,
      wx.rain_mm ?? null,
      wx.rain_24h_mm ?? null,
      wx.luminosity_wm2 ?? null,
      source,
    )
    .run();
  await env.DB.prepare("UPDATE wx_keys SET last_seen = ? WHERE key = ?").bind(nowS(), key).run();

  if (place) {
    await env.DB.prepare(
      `INSERT INTO stations (callsign, lat, lon, last_seen, symbol, source_call) VALUES (?,?,?,?, '_', ?)
       ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen, symbol='_'`,
    )
      .bind(station, place.lat, place.lon, ts, station)
      .run();
  }

  // If this PWS opted into TX (and its callsign is control-verified), enqueue an APRS WX
  // beacon — to standard APRS-IS and/or to CWOP/NOAA — throttled. Never blocks the ingest ack.
  await maybeBeaconWx(env, { key, station, baseCall: baseCall(row.callsign), place, wx });

  return new Response("success\n", { headers: { "content-type": "text/plain" } }); // WU expects this body
}

/** Map a stored metric reading to the encoder's wire-unit input. */
function toWxFields(wx: WxReading): WxEncodeFields {
  return {
    tempC: wx.temp_c,
    humidity: wx.humidity,
    pressureHpa: wx.pressure_hpa,
    windDirDeg: wx.wind_dir,
    windKn: wx.wind_kn,
    gustKn: wx.gust_kn,
    rainMm: wx.rain_mm,
    rain24hMm: wx.rain_24h_mm,
    luminosityWm2: wx.luminosity_wm2,
  };
}

/**
 * Queue a WX beacon for a verified, opted-in PWS. Gated on callsign control-verification: TX is off by
 * default; both the verified-callsign check and the per-station opt-in must pass. A WX report needs
 * a position, so a station with no coordinates is skipped. Throttled to WX_BEACON_MIN_SEC.
 */
async function maybeBeaconWx(
  env: Env,
  o: { key: string; station: string; baseCall: string; place: { lat: number; lon: number } | null; wx: WxReading },
): Promise<void> {
  const k = await env.DB.prepare(
    "SELECT tx_is AS txIs, tx_cwop AS txCwop, last_beacon AS lastBeacon FROM wx_keys WHERE key = ?",
  )
    .bind(o.key)
    .first<{ txIs: number; txCwop: number; lastBeacon: number | null }>();
  if (!k || (!k.txIs && !k.txCwop)) return;
  if (!o.place) return; // a WX report must carry a position
  if (nowS() - (k.lastBeacon ?? 0) < WX_BEACON_MIN_SEC) return; // throttle
  if (!(await isCallsignVerified(env, o.baseCall))) return; // control-verified gate
  if (await callSuspended(env, o.station)) return; // a suspended call sends nothing

  const info = encodeAprsWeather(o.place.lat, o.place.lon, toWxFields(o.wx));
  const ts = nowS();
  const targets: string[] = [];
  if (k.txIs) targets.push("is");
  if (k.txCwop) targets.push("cwop");
  for (const target of targets) {
    await env.DB.prepare(
      "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload, target) VALUES (?,?,?, 'wx', ?, ?)",
    )
      .bind(ts, o.station, "APZACG", info, target)
      .run();
  }
  await env.DB.prepare("UPDATE wx_keys SET last_beacon = ? WHERE key = ?").bind(ts, o.key).run();
}

/** Generate a station's PWS push key. */
export function makeWxKey(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return "wx_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Ready-to-paste ingest URLs for a station's PWS key (Ecowitt customized path + WU Rapidfire). */
export function wxUrls(origin: string, station: string, key: string): { ecowittPath: string; wuUrl: string } {
  return {
    ecowittPath: `${origin}/api/wx/submit?key=${key}`,
    wuUrl: `${origin}/api/wx/updateweatherstation?ID=${encodeURIComponent(station)}&PASSWORD=${key}`,
  };
}

/**
 * POST /api/wx/tx — toggle a weather station's APRS-IS weather beacon and/or CWOP relay. Gated: requires a
 * signed-in session that owns the station AND the station's base call control-verified to ENABLE either
 * (TX is off by default).
 * `stationId` names the caller's weather station whose key the switches belong to.
 */
export async function handleWxTx(req: Request, env: Env): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in to manage weather TX" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { stationId?: number; txIs?: boolean; txCwop?: boolean };
  const txIs = !!body.txIs,
    txCwop = !!body.txCwop;
  if (body.stationId == null) return json({ error: "name the weather station (stationId)" }, { status: 400 });
  const row = await env.DB.prepare(
    `SELECT wk.key AS key, s.callsign AS callsign FROM wx_keys wk JOIN account_stations s ON s.id = wk.station_id
      WHERE wk.station_id = ? AND s.account_id = ?`,
  )
    .bind(body.stationId, acct)
    .first<{ key: string; callsign: string }>();
  if (!row) return json({ error: "enable weather push on the station first" }, { status: 400 });

  // the station transmits under its own callsign, so its base call is the one that must be control-verified
  const base = baseCall(row.callsign);
  const verified = await isCallsignVerified(env, base);
  if ((txIs || txCwop) && !verified)
    return json({ error: `verify ${base} to transmit weather`, verified: false }, { status: 403 });

  await env.DB.prepare("UPDATE wx_keys SET tx_is = ?, tx_cwop = ? WHERE key = ?")
    .bind(txIs ? 1 : 0, txCwop ? 1 : 0, row.key)
    .run();
  return json({ txIs, txCwop, verified });
}
