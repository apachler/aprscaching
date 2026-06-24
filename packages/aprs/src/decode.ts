/**
 * decode.ts — top-level APRS payload decoder (APRS101). Dispatches on the data-type identifier
 * (first payload byte) to produce a typed `AprsData`. Builds on parsePosition (uncompressed),
 * parseCompressed (base-91), decodeMicE, plus object/item/message/status/weather/telemetry.
 */
import type { ParsedFrame, AprsData, DecodedPosition, DecodedWeather } from "./types.js";
import { lookupSymbol } from "./symbols.js";
import { parseCompressed } from "./compressed.js";
import { decodeMicE } from "./mice.js";

const UNCOMP_RE = /^(\d{2})([0-7 ][0-9 ]\.[0-9 ]{2})([NS])(.)(\d{3})([0-7 ][0-9 ]\.[0-9 ]{2})([EW])(.)/;

/** Parse an uncompressed "DDMM.hhN/DDDMM.hhW$" head; returns the fix + the comment remainder. */
function parseUncompressed(s: string): { fix: DecodedPosition; rest: string } | null {
  const m = UNCOMP_RE.exec(s);
  if (!m) return null;
  const [whole, latDeg, latMin, ns, table, lonDeg, lonMin, ew, code] = m;
  const ambiguity = (latMin!.match(/ /g)?.length ?? 0) + (lonMin!.match(/ /g)?.length ?? 0);
  const latMinNum = Number(latMin!.replace(/ /g, "0"));
  const lonMinNum = Number(lonMin!.replace(/ /g, "0"));
  let lat = Number(latDeg) + latMinNum / 60;
  let lon = Number(lonDeg) + lonMinNum / 60;
  if (ns === "S") lat = -lat;
  if (ew === "W") lon = -lon;
  const fix: DecodedPosition = { lat: round(lat), lon: round(lon), symbol: lookupSymbol(table!, code!), ambiguity };
  return { fix, rest: s.slice(whole!.length) };
}

/** Course/speed "CSE/SPD", altitude "/A=dddddd", and PHG out of a comment string. */
function applyExtensions(fix: DecodedPosition, comment: string): void {
  const cs = /^(\d{3})\/(\d{3})/.exec(comment);
  if (cs) { fix.course = Number(cs[1]); fix.speedKn = Number(cs[2]); comment = comment.slice(7); }
  const alt = /\/A=(-?\d{6})/.exec(comment);
  if (alt) { fix.altitudeM = Math.round(Number(alt[1]) * 0.3048); comment = comment.replace(alt[0], ""); }
  const c = comment.trim();
  if (c) fix.comment = c;
}

/** Weather fields out of an APRS weather comment (after the wind dir/speed head). */
function parseWeather(s: string): DecodedWeather {
  const wx: DecodedWeather = {};
  const num = (re: RegExp, scale = 1) => { const m = re.exec(s); return m && m[1] !== "..." ? Number(m[1]) * scale : undefined; };
  const head = /^[\/_]?(\d{3})\/(\d{3})/.exec(s) ?? /^(\d{3})\/(\d{3})/.exec(s);
  if (head) { wx.windDirDeg = Number(head[1]); wx.windKn = Number(head[2]); }
  const g = num(/g(\d{3})/); if (g !== undefined) wx.gustKn = g;
  const t = /t(-?\d{2,3})/.exec(s); if (t) wx.tempC = Math.round(((Number(t[1]) - 32) * 5 / 9) * 10) / 10;
  const r = num(/r(\d{3})/, 0.254); if (r !== undefined) wx.rain1hMm = round(r);
  const p = num(/p(\d{3})/, 0.254); if (p !== undefined) wx.rain24hMm = round(p);
  const P = num(/P(\d{3})/, 0.254); if (P !== undefined) wx.rainMidnightMm = round(P);
  const h = /h(\d{2})/.exec(s); if (h) wx.humidity = Number(h[1]) === 0 ? 100 : Number(h[1]);
  const b = num(/b(\d{5})/, 0.1); if (b !== undefined) wx.pressureHpa = round(b);
  return wx;
}
const isWeather = (s: string) => /^[\/_]?\d{3}\/\d{3}/.test(s) && /[tgrph]/.test(s);

export function decodeAprs(frame: ParsedFrame): AprsData {
  const p = frame.payload;
  const t = p[0] ?? "";

  // MIC-E: type id is one of these and latitude lives in the destination
  if ((t === "`" || t === "'" || t === "\x1c" || t === "\x1d") && frame.dst) {
    const me = decodeMicE(frame.dst, p);
    if (me) return { kind: "position", lat: me.lat, lon: me.lon, symbol: lookupSymbol(me.table, me.code), course: me.course, speedKn: me.speedKn, altitudeM: me.altitudeM, comment: me.comment, ambiguity: me.ambiguity, messageType: me.messageType };
  }

  switch (t) {
    case "!": case "=": case "@": case "/": {
      // strip a timestamp for @ and / (7 chars: DDHHMMz or HHMMSSh)
      let body = p.slice(1), timestamp: string | undefined;
      if (t === "@" || t === "/") { timestamp = body.slice(0, 7); body = body.slice(7); }
      return decodePosition(body, timestamp);
    }
    case ";": return decodeObject(p);
    case ")": return decodeItem(p);
    case ":": return decodeMessage(p);
    case ">": return { kind: "status", text: p.slice(1).trim() };
    case "_": { // positionless weather: _MMDDHHMM<wx>
      return { kind: "weather", ...parseWeather(p.slice(9)) };
    }
    case "T": { // telemetry: T#seq,a1,a2,a3,a4,a5,bbbbbbbb
      return decodeTelemetry(p);
    }
    default: return { kind: "other" };
  }
}

function decodePosition(body: string, timestamp?: string): AprsData {
  let fix: DecodedPosition | null = null, rest = "";
  const comp = parseCompressed(body);
  if (comp) {
    fix = { lat: round(comp.lat), lon: round(comp.lon), symbol: lookupSymbol(comp.table, comp.code), course: comp.course, speedKn: comp.speedKn, altitudeM: comp.altitudeM };
    rest = body.slice(13);
  } else {
    const u = parseUncompressed(body);
    if (u) { fix = u.fix; rest = u.rest; }
  }
  if (!fix) return { kind: "other" };
  if (timestamp) fix.timestamp = timestamp;
  // weather station (symbol '_') with wx in the comment -> weather report
  if (fix.symbol?.code === "_" && isWeather(rest)) return { kind: "weather", lat: fix.lat, lon: fix.lon, symbol: fix.symbol, ...parseWeather(rest) };
  applyExtensions(fix, rest);
  return { kind: "position", ...fix };
}

function posFields(pos: AprsData): DecodedPosition {
  if (pos.kind !== "position") return { lat: 0, lon: 0 };
  const { kind, ...fields } = pos;
  return fields;
}

function decodeObject(p: string): AprsData {
  // ;NAME_____*DDHHMMz<position>   ('*' alive, '_' killed)
  const name = p.slice(1, 10).trim();
  const alive = p[10] === "*";
  const body = p.slice(11).slice(7); // strip the 7-char timestamp
  return { kind: "object", name, alive, ...posFields(decodePosition(body)) };
}

function decodeItem(p: string): AprsData {
  // )NAME!<position>  or )NAME_<position>  (name 3-9 chars, '!' alive / '_' killed)
  const m = /^\)([^!_]{3,9})([!_])(.*)$/s.exec(p);
  if (!m) return { kind: "other" };
  return { kind: "item", name: m[1]!.trim(), alive: m[2] === "!", ...posFields(decodePosition(m[3]!)) };
}

function decodeMessage(p: string): AprsData {
  // :ADDRESSEE:text{msgNo   (addressee padded to 9)
  const m = /^:(.{9}):(.*)$/s.exec(p);
  if (!m) return { kind: "other" };
  const addressee = m[1]!.trim();
  let text = m[2]!;
  const out: AprsData = { kind: "message", addressee, text };
  if (/^ack/.test(text)) { out.ack = true; out.msgNo = text.slice(3).trim(); out.text = ""; return out; }
  if (/^rej/.test(text)) { out.rej = true; out.msgNo = text.slice(3).trim(); out.text = ""; return out; }
  const mn = /\{([^}]+)$/.exec(text);
  if (mn) { out.msgNo = mn[1]; out.text = text.slice(0, mn.index); }
  if (/^(BLN|NWS|SKY)/.test(addressee)) out.bulletin = addressee;
  return out;
}

function decodeTelemetry(p: string): AprsData {
  const m = /^#?(\d+)?,?(.*)$/.exec(p.slice(1));
  if (!m) return { kind: "telemetry", analog: [], digital: [] };
  const seq = m[1] ? Number(m[1]) : undefined;
  const parts = (m[2] ?? "").split(",");
  const analog = parts.slice(0, 5).map(Number).filter((n) => !Number.isNaN(n));
  const bits = parts[5] ?? "";
  const digital = /^[01]{1,8}$/.test(bits) ? [...bits].map((b) => b === "1") : [];
  return { kind: "telemetry", seq, analog, digital };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
