// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * wx.ts — weather user-origination. A personal weather station pushes directly to the
 * platform; the reading is stored in sensor_readings under the user's <call>-13 weather SSID. We
 * speak the formats consumer stations already emit (Ecowitt "customized" HTTP push + Weather
 * Underground "Rapidfire" GET), so most stations work by just pointing them at the URL with a key.
 * Platform-only ingest carries NO RF-licence implication (the licence gate is only for TX/CWOP).
 *
 *   GET/POST /api/wx/submit              push a reading (?key=… ; or WU PASSWORD=key)
 *   GET/POST /api/wx/updateweatherstation  WU-Rapidfire alias
 *   GET/POST /api/wx/key                 (session) read / (re)issue your push key + URLs
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionCallsign } from "./auth.js";
import { sessionAccountId } from "./watch.js";
import { gridToLatLon } from "@aprscaching/shared";
import { encodeAprsWeather, type WxEncodeFields } from "@aprscaching/aprs";
import { isCallsignVerified } from "./callsign.js";

const WX_BEACON_MIN_SEC = 300; // throttle WX beacons to ≤ once / 5 min (cost + APRS etiquette)

const now = () => Math.floor(Date.now() / 1000);
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
  const row = await env.DB.prepare("SELECT callsign, station_id AS stationId FROM wx_keys WHERE key = ?")
    .bind(key)
    .first<{ callsign: string; stationId: number | null }>();
  if (!row) return new Response("unknown key", { status: 401 });

  const wx = parseWx(get);
  if (wx.temp_c == null && wx.humidity == null && wx.pressure_hpa == null && wx.wind_kn == null && wx.rain_mm == null)
    return new Response("no recognised weather fields", { status: 400 });

  // Resolve where this reading lands + how to place it on the map. A key bound to a registry station
  // uses that station's callsign + EXPLICIT coordinates (so a remote mountain PWS sits at
  // its real location); a home key falls back to the operator's <call>-13 home PWS placed from
  // their home grid.
  let station = `${row.callsign.toUpperCase()}-13`;
  let place: { lat: number; lon: number } | null = null;
  if (row.stationId != null) {
    const s = await env.DB.prepare("SELECT callsign, lat, lon FROM account_stations WHERE id = ?")
      .bind(row.stationId)
      .first<{ callsign: string; lat: number | null; lon: number | null }>();
    if (s) {
      station = s.callsign.toUpperCase();
      place = s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : null;
    }
  } else {
    const acct = await env.DB.prepare("SELECT home_grid AS homeGrid FROM accounts WHERE callsign = ?")
      .bind(row.callsign.toUpperCase())
      .first<{ homeGrid: string | null }>();
    place = acct?.homeGrid ? gridToLatLon(acct.homeGrid) : null;
  }

  const ts = (() => {
    const d = get("dateutc");
    if (d && d !== "now") {
      const t = Date.parse(d.replace(" ", "T") + "Z");
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
    return now();
  })();
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
  await env.DB.prepare("UPDATE wx_keys SET last_seen = ? WHERE key = ?").bind(now(), key).run();

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
  await maybeBeaconWx(env, { key, station, baseCall: row.callsign.toUpperCase().split("-")[0]!, place, wx });

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
  if (now() - (k.lastBeacon ?? 0) < WX_BEACON_MIN_SEC) return; // throttle
  if (!(await isCallsignVerified(env, o.baseCall))) return; // control-verified gate

  const info = encodeAprsWeather(o.place.lat, o.place.lon, toWxFields(o.wx));
  const ts = now();
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

/** Generate a PWS push key. Shared by the home-PWS endpoint and per-station keys. */
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

/** GET/POST /api/wx/key — read or (re)issue the caller's home (<call>-13) PWS push key + URLs. */
export async function handleWxKey(req: Request, env: Env): Promise<Response> {
  const cs = await sessionCallsign(req, env);
  if (!cs) return json({ error: "sign in to set up a weather station" }, { status: 401 });
  const base = cs.toUpperCase().split("-")[0]!;
  const station = `${base}-13`;
  if (req.method === "POST") {
    await env.DB.prepare("DELETE FROM wx_keys WHERE callsign = ? AND station_id IS NULL").bind(base).run();
    await env.DB.prepare("INSERT INTO wx_keys (key, callsign, account_id, created_at) VALUES (?,?,?,?)")
      .bind(makeWxKey(), base, await sessionAccountId(req, env), now())
      .run();
  }
  const row = await env.DB.prepare(
    "SELECT key, last_seen AS lastSeen, tx_is AS txIs, tx_cwop AS txCwop FROM wx_keys WHERE callsign = ? AND station_id IS NULL",
  )
    .bind(base)
    .first<{ key: string; lastSeen: number | null; txIs: number; txCwop: number }>();
  const origin = new URL(req.url).origin;
  const urls = row ? wxUrls(origin, station, row.key) : null;
  return json({
    callsign: base,
    station,
    key: row?.key ?? null,
    lastSeen: row?.lastSeen ?? null,
    ecowittPath: urls?.ecowittPath ?? null,
    wuUrl: urls?.wuUrl ?? null,
    txIs: !!row?.txIs,
    txCwop: !!row?.txCwop,
    verified: await isCallsignVerified(env, base),
  });
}

/**
 * POST /api/wx/tx — toggle a PWS's APRS-IS weather beacon and/or CWOP relay. Gated: requires a
 * signed-in session AND a control-verified callsign to ENABLE either (TX is off by default).
 * `stationId` targets a registry station's key; omitted targets the home <call>-13 key.
 */
export async function handleWxTx(req: Request, env: Env): Promise<Response> {
  const cs = await sessionCallsign(req, env);
  if (!cs) return json({ error: "sign in to manage weather TX" }, { status: 401 });
  const base = cs.toUpperCase().split("-")[0]!;
  const body = (await req.json().catch(() => ({}))) as { stationId?: number; txIs?: boolean; txCwop?: boolean };
  const txIs = !!body.txIs,
    txCwop = !!body.txCwop;

  const verified = await isCallsignVerified(env, base);
  if ((txIs || txCwop) && !verified)
    return json({ error: "verify your callsign to transmit weather", verified: false }, { status: 403 });

  // locate the caller's key row (home, or an owned registry station)
  let row: { key: string } | null;
  if (body.stationId != null) {
    const acct = await sessionAccountId(req, env);
    row = await env.DB.prepare(
      `SELECT wk.key AS key FROM wx_keys wk JOIN account_stations s ON s.id = wk.station_id
        WHERE wk.station_id = ? AND s.account_id = ?`,
    )
      .bind(body.stationId, acct)
      .first<{ key: string }>();
  } else {
    row = await env.DB.prepare("SELECT key FROM wx_keys WHERE callsign = ? AND station_id IS NULL")
      .bind(base)
      .first<{ key: string }>();
  }
  if (!row) return json({ error: "enable the weather station first" }, { status: 400 });

  await env.DB.prepare("UPDATE wx_keys SET tx_is = ?, tx_cwop = ? WHERE key = ?")
    .bind(txIs ? 1 : 0, txCwop ? 1 : 0, row.key)
    .run();
  return json({ txIs, txCwop, verified });
}
