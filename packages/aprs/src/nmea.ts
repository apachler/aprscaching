// SPDX-License-Identifier: MIT
/**
 * nmea.ts — raw NMEA 0183 sentences in the information field (APRS 1.2, "NMEA Data" and "Raw NMEA Position
 * Report Format"). Early trackers sent their GPS receiver's output as it came; the spec asks a receiver to read
 * at least GGA, GLL, RMC, VTG and WPL. The talker is `GP` (GPS) or one of the other GNSS talkers a newer receiver
 * uses: `GN` (combined), `GL` (GLONASS), `GA` (Galileo), `GB` / `BD` (BeiDou).
 *
 * Such a report carries no symbol: it comes from the destination address (`GPSxyz`, `GPSCnn`, `GPSEnn`,
 * `SPCxyz`, `SYMxyz`), else from the source address SSID (`symbolFromAddress` in symbols.ts).
 */
import { isValidLatLon } from "./geo.js";

export type NmeaSentence = "GGA" | "GLL" | "RMC" | "VTG" | "WPL";

/** What a sentence says. GGA, GLL, RMC and WPL carry a position; VTG only the course and speed. */
export interface NmeaReport {
  sentence: NmeaSentence;
  lat?: number;
  lon?: number;
  /** Course over ground in degrees, 1–360 (360 is north); absent when not sent. */
  course?: number;
  speedKn?: number;
  /** GGA's altitude above mean sea level. */
  altitudeM?: number;
  /** The fix's UTC time, `HHMMSS`. */
  time?: string;
  /** WPL's waypoint name. */
  waypoint?: string;
}

const HEAD_RE = /^\$(GP|GN|GL|GA|GB|BD)(GGA|GLL|RMC|VTG|WPL),/;
/** The checksum: `*` and two hex digits at the end, before any line ending. */
const CHECKSUM_RE = /\*([0-9A-Fa-f]{2})[\r\n]*$/;
const LAT_RE = /^(\d{2})(\d{2}(?:\.\d{1,8})?)$/;
const LON_RE = /^(\d{3})(\d{2}(?:\.\d{1,8})?)$/;
const NUM_RE = /^\d{1,6}(?:\.\d{1,6})?$/;
const SIGNED_NUM_RE = /^-?\d{1,6}(?:\.\d{1,6})?$/;
/** At most this long: an NMEA sentence is 82 characters; the slack covers a TNC's trailing bytes. */
const MAX_LEN = 200;

/** One coordinate, `ddmm.mmmm` with its hemisphere letter; null when malformed or its minutes reach 60. */
function coord(v: string | undefined, hemi: string | undefined, re: RegExp, pos: string, neg: string): number | null {
  const m = re.exec(v ?? "");
  if (!m || (hemi !== pos && hemi !== neg)) return null;
  const min = Number(m[2]);
  if (min >= 60) return null;
  const deg = Number(m[1]) + min / 60;
  return hemi === neg ? -deg : deg;
}

/** The position in the four fields from `at` (lat, N/S, lon, E/W), or null when malformed or off the globe. */
function position(f: string[], at: number): { lat: number; lon: number } | null {
  const lat = coord(f[at], f[at + 1], LAT_RE, "N", "S"),
    lon = coord(f[at + 2], f[at + 3], LON_RE, "E", "W");
  if (lat === null || lon === null || !isValidLatLon(lat, lon)) return null;
  return { lat: round(lat), lon: round(lon) };
}

/** A course in degrees: 0 and 360 are north (360 in APRS, where 0 is unknown); past 360 is not a heading. */
function course(v: string | undefined): number | undefined {
  if (!v || !NUM_RE.test(v)) return undefined;
  const c = Math.round(Number(v));
  if (c > 360) return undefined;
  return c === 0 ? 360 : c;
}

const num = (v: string | undefined) => (v && NUM_RE.test(v) ? Number(v) : undefined);
const time = (v: string | undefined) => (v && /^\d{6}(?:\.\d{1,3})?$/.test(v) ? v.slice(0, 6) : undefined);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The sentence an information field holds, or null when it is no NMEA sentence this reads, its checksum is
 * wrong, or it reports no valid fix: an RMC or GLL marked `V` (void) or with the mode `N` (not valid), a GGA of
 * fix quality 0. A sentence without a checksum is read, as the early trackers sent it.
 */
export function parseNmea(info: string): NmeaReport | null {
  if (info.length > MAX_LEN) return null;
  const head = HEAD_RE.exec(info);
  if (!head) return null;
  let body = info.slice(1);
  const sum = CHECKSUM_RE.exec(info);
  if (sum) {
    body = info.slice(1, sum.index);
    let x = 0;
    for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
    if (x !== parseInt(sum[1]!, 16)) return null;
  } else if (info.includes("*")) return null;
  const f = body.trimEnd().split(",");
  const sentence = head[2] as NmeaSentence;
  switch (sentence) {
    case "RMC": {
      // time, status, lat, N/S, lon, E/W, speed (kn), course, date, magnetic variation, E/W[, mode]
      if (f[2] !== "A" || f[12] === "N") return null;
      const fix = position(f, 3);
      if (!fix) return null;
      const speed = num(f[7]);
      return {
        sentence,
        ...fix,
        ...(speed !== undefined ? { speedKn: round1(speed) } : {}),
        ...opt("course", course(f[8])),
        ...opt("time", time(f[1])),
      };
    }
    case "GGA": {
      // time, lat, N/S, lon, E/W, fix quality (0 none), satellites, HDOP, altitude, M, geoid height, M, …
      if (!f[6] || f[6] === "0" || !/^\d$/.test(f[6])) return null;
      const fix = position(f, 2);
      if (!fix) return null;
      const alt = f[10] === "M" && f[9] && SIGNED_NUM_RE.test(f[9]) ? Math.round(Number(f[9])) : undefined;
      return { sentence, ...fix, ...opt("altitudeM", alt), ...opt("time", time(f[1])) };
    }
    case "GLL": {
      // lat, N/S, lon, E/W[, time, status A/V[, mode]]
      if (f[6] === "V" || f[7] === "N") return null;
      const fix = position(f, 1);
      if (!fix) return null;
      return { sentence, ...fix, ...opt("time", time(f[5])) };
    }
    case "WPL": {
      // lat, N/S, lon, E/W, waypoint name
      const fix = position(f, 1);
      const waypoint = (f[5] ?? "").trim();
      if (!fix || !waypoint) return null;
      return { sentence, ...fix, waypoint };
    }
    case "VTG": {
      // true course, T, magnetic course, M, speed (kn), N, speed (km/h), K[, mode]
      if (f[9] === "N") return null;
      const speed = num(f[5]);
      return {
        sentence,
        ...opt("course", course(f[1])),
        ...(speed !== undefined ? { speedKn: round1(speed) } : {}),
      };
    }
  }
}

/** `{ [key]: value }` when the value is present, else nothing to spread. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
