/**
 * wx.ts — weather user-origination (docs/17 W1). A personal weather station pushes directly to the
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
import { gridToLatLon } from "@aprsweb/shared";

const now = () => Math.floor(Date.now() / 1000);
const num = (v: string | undefined): number | undefined => { if (v == null || v === "") return undefined; const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const fToC = (f: number) => r1(((f - 32) * 5) / 9);
const inHgToHpa = (x: number) => r1(x * 33.8638867);
const mphToKn = (x: number) => r1(x * 0.868976);
const inToMm = (x: number) => r1(x * 25.4);

export interface WxReading {
  temp_c?: number; humidity?: number; pressure_hpa?: number; wind_dir?: number; wind_kn?: number;
  gust_kn?: number; rain_mm?: number; rain_24h_mm?: number; luminosity_wm2?: number;
}

/** Parse an Ecowitt / WU parameter bag (imperial) into our metric reading. */
export function parseWx(get: (k: string) => string | undefined): WxReading {
  const g = (...keys: string[]): number | undefined => { for (const k of keys) { const v = num(get(k)); if (v != null) return v; } return undefined; };
  const tempf = g("tempf", "temp"), barom = g("baromrelin", "baromin", "barom"), wind = g("windspeedmph", "windspeed");
  const gust = g("windgustmph", "windgust"), rainHr = g("hourlyrainin", "rainin"), rainDay = g("dailyrainin");
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
      if (ct.includes("application/json")) { const b = await req.json() as Record<string, unknown>; for (const [k, v] of Object.entries(b)) map.set(k.toLowerCase(), String(v)); }
      else { const t = await req.text(); for (const [k, v] of new URLSearchParams(t)) map.set(k.toLowerCase(), v); }
    } catch { /* ignore */ }
  }
  return (k) => map.get(k.toLowerCase());
}

/** GET/POST /api/wx/submit (+ /updateweatherstation) — store a PWS reading under <call>-13. */
export async function handleWxSubmit(req: Request, env: Env): Promise<Response> {
  const get = await readParams(req);
  const key = get("key") ?? get("password");  // our key, or WU's PASSWORD field
  if (!key) return new Response("missing key", { status: 401 });
  const row = await env.DB.prepare("SELECT callsign FROM wx_keys WHERE key = ?").bind(key).first<{ callsign: string }>();
  if (!row) return new Response("unknown key", { status: 401 });

  const wx = parseWx(get);
  if (wx.temp_c == null && wx.humidity == null && wx.pressure_hpa == null && wx.wind_kn == null && wx.rain_mm == null)
    return new Response("no recognised weather fields", { status: 400 });

  const station = `${row.callsign.toUpperCase()}-13`;
  const ts = (() => { const d = get("dateutc"); if (d && d !== "now") { const t = Date.parse(d.replace(" ", "T") + "Z"); if (Number.isFinite(t)) return Math.floor(t / 1000); } return now(); })();
  const source = get("stationtype") || get("softwaretype") ? "ecowitt" : get("id") ? "wu" : "ecowitt";
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sensor_readings (station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, gust_kn, rain_mm, rain_24h_mm, luminosity_wm2, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(station, ts, wx.temp_c ?? null, wx.humidity ?? null, wx.pressure_hpa ?? null, wx.wind_dir ?? null, wx.wind_kn ?? null, wx.gust_kn ?? null, wx.rain_mm ?? null, wx.rain_24h_mm ?? null, wx.luminosity_wm2 ?? null, source).run();
  await env.DB.prepare("UPDATE wx_keys SET last_seen = ? WHERE key = ?").bind(now(), key).run();

  // place the weather station on the map from the operator's home grid (so the reading is visible).
  const acct = await env.DB.prepare("SELECT home_grid AS homeGrid FROM accounts WHERE callsign = ?").bind(row.callsign.toUpperCase()).first<{ homeGrid: string | null }>();
  const ll = acct?.homeGrid ? gridToLatLon(acct.homeGrid) : null;
  if (ll) {
    await env.DB.prepare(
      `INSERT INTO stations (callsign, lat, lon, last_seen, symbol, source_call) VALUES (?,?,?,?, '_', ?)
       ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen, symbol='_'`,
    ).bind(station, ll.lat, ll.lon, ts, station).run();
  }
  return new Response("success\n", { headers: { "content-type": "text/plain" } }); // WU expects this body
}

function makeKey(): string {
  const b = new Uint8Array(12); crypto.getRandomValues(b);
  return "wx_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** GET/POST /api/wx/key — read or (re)issue the caller's PWS push key + ready-to-paste URLs. */
export async function handleWxKey(req: Request, env: Env): Promise<Response> {
  const cs = await sessionCallsign(req, env);
  if (!cs) return json({ error: "sign in to set up a weather station" }, { status: 401 });
  const base = cs.toUpperCase().split("-")[0]!;
  if (req.method === "POST") {
    await env.DB.prepare("DELETE FROM wx_keys WHERE callsign = ?").bind(base).run();
    const key = makeKey();
    await env.DB.prepare("INSERT INTO wx_keys (key, callsign, account_id, created_at) VALUES (?,?,?,?)")
      .bind(key, base, await sessionAccountId(req, env), now()).run();
  }
  const row = await env.DB.prepare("SELECT key, last_seen AS lastSeen FROM wx_keys WHERE callsign = ?").bind(base).first<{ key: string; lastSeen: number | null }>();
  const origin = new URL(req.url).origin;
  return json({
    callsign: base, station: `${base}-13`, key: row?.key ?? null, lastSeen: row?.lastSeen ?? null,
    ecowittPath: row ? `${origin}/api/wx/submit?key=${row.key}` : null,
    wuUrl: row ? `${origin}/api/wx/updateweatherstation?ID=${base}-13&PASSWORD=${row.key}` : null,
  });
}
