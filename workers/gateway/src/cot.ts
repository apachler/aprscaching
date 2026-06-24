/**
 * cot.ts — M6 interop: a Cursor-on-Target (CoT) bridge so TAK clients (ATAK/WinTAK/iTAK) can
 * consume our live APRS station registry. CoT is an open MITRE schema; we map each station to an
 * <event> and return a snapshot <events> document over a bbox. Pure builder + a thin handler so the
 * mapping is conformance-tested on both runtimes.
 */
import type { Env } from "./env.js";

interface CotStation {
  callsign: string; lat: number; lon: number; symbol: string | null;
  course: number | null; speedKn: number | null; altitudeM: number | null;
  comment: string | null; lastSeen: number;
}

const UNK = 9999999.0;            // CoT "unknown" sentinel for hae/ce/le
const KN_TO_MS = 0.514444;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

/** Map an APRS symbol (table+code) to a coarse CoT 2525-ish type. Friendly by default. */
export function cotType(symbol: string | null): string {
  const code = symbol && symbol.length >= 2 ? symbol[1] : symbol?.[0];
  switch (code) {
    case ">": case "<": case "j": case "k": case "u": case "v": case "=": return "a-f-G-E-V-C"; // ground vehicle
    case "^": case "'": case "X": case "g": case "O": return "a-f-A"; // aircraft
    case "Y": case "s": case "C": return "a-f-S"; // surface/marine
    case "_": case "W": return "a-f-G-I-U-T"; // weather/sensor
    case "#": case "r": return "a-f-G-I-U-R"; // infrastructure (digi/repeater)
    default: return "a-f-G-U-C"; // generic friendly ground combat unit
  }
}

/** Build a single CoT <event> for a station. `now` = current unix seconds. */
export function stationToCotEvent(s: CotStation, now: number, staleSec = 300): string {
  const hae = s.altitudeM != null ? s.altitudeM.toFixed(1) : UNK.toFixed(1);
  const detail: string[] = [`<contact callsign="${xml(s.callsign)}"/>`];
  if (s.course != null || s.speedKn != null)
    detail.push(`<track course="${s.course ?? 0}" speed="${((s.speedKn ?? 0) * KN_TO_MS).toFixed(2)}"/>`);
  detail.push(`<remarks>${xml(`APRS ${s.symbol ?? ""}${s.comment ? ` ${s.comment}` : ""}`.trim())}</remarks>`);
  return (
    `<event version="2.0" uid="APRS.${xml(s.callsign)}" type="${cotType(s.symbol)}"` +
    ` time="${iso(now)}" start="${iso(s.lastSeen)}" stale="${iso(s.lastSeen + staleSec)}" how="m-g">` +
    `<point lat="${s.lat}" lon="${s.lon}" hae="${hae}" ce="${UNK}" le="${UNK}"/>` +
    `<detail>${detail.join("")}</detail></event>`
  );
}

export async function handleCot(req: Request, env: Env, now: number): Promise<Response> {
  const u = new URL(req.url);
  const b = u.searchParams.get("bbox");
  const maxAge = Math.min(Math.max(Number(u.searchParams.get("maxAge") ?? 3600) || 3600, 60), 86400);
  let where = "lat IS NOT NULL AND last_seen >= ?";
  const binds: number[] = [now - maxAge];
  if (b) {
    const p = b.split(",").map(Number);
    if (p.length >= 4 && !p.some(Number.isNaN)) {
      const [minLon, minLat, maxLon, maxLat] = p as [number, number, number, number];
      where += " AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
      binds.push(minLat, maxLat, minLon, maxLon);
    }
  }
  const rows = (await env.DB.prepare(
    `SELECT callsign, lat, lon, symbol, course, speed_kn AS speedKn, altitude_m AS altitudeM,
            comment, last_seen AS lastSeen FROM stations WHERE ${where} ORDER BY last_seen DESC LIMIT 2000`,
  ).bind(...binds).all<CotStation>()).results;

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<events>${rows.map((r) => stationToCotEvent(r, now)).join("")}</events>`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
