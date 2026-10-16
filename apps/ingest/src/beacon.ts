// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * beacon.ts — the box's automatic position beacons, off unless the operator sets `BEACON=fixed|smart`.
 *
 * One scheduler runs per transmitting radio port: the KISS TNC's transmit channel (`KISS_TNC_TX_CHANNEL`) and each
 * soundcard port that may transmit. A beacon passes every gate any frame of the box passes: the port's own call
 * gate (the gateway confirms the station call is control-verified for this box), the master transmit switch, and
 * a token bucket of its own (`BEACON_TX_BURST`, `BEACON_TX_REFILL_SEC`).
 *
 * `fixed` beacons every `BEACON_INTERVAL_MIN` minutes (20 by default, never more often than every 10). `smart` is
 * SmartBeaconing, the algorithm of Tony Arnerich KD7TA and Steve Bragg KA9MVA for the HamHUD
 * (http://www.hamhud.net/hh2/smartbeacon.html): below `low_speed` the station beacons at `slow_rate`; above
 * `high_speed` at `fast_rate`; between them at `fast_rate × high_speed / speed`. A turn sharper than
 * `turn_min + turn_slope / speed` beacons at once ("corner pegging"), once `turn_time` has passed since the last.
 * The defaults are the usual tracker ones, in metric: 5 km/h and 30 min, 90 km/h and 90 s, 28°, a turn slope of
 * 255 degree·mph (the HamHUD's and Direwolf's), and 30 s. The slow and fast rates are settings
 * (`BEACON_SLOW_MIN`, `BEACON_FAST_SEC`): a station that is a living cache sets the slow rate to 4 min or less,
 * since a find needs the station's position within 5 min of the player's.
 *
 * On an HF port (`SOUNDCARD_MODEM=hf300`) the HF preset applies whatever the mode: at most one beacon in
 * `HF_APRS.beaconMinSec`, Mic-E, no path, the comment on every fourth beacon only.
 *
 * On VHF a box at a fixed position sends an uncompressed position with its comment; a moving source (Termux, gpsd,
 * NMEA) sends Mic-E: nine bytes for the position with its speed, course and altitude, against the nineteen of an
 * uncompressed position that would need seven more for course and speed, and every APRS radio decodes it.
 */
import { HF_APRS, encodeAprsPosition, encodeMicE, hfBeacon, isAprsSymbol, rfBytes } from "@aprscaching/aprs";
import type { Fix, PositionKind, PositionSource } from "./gps.js";
import type { TokenBucket } from "./txlimit.js";

export type BeaconMode = "fixed" | "smart";

export interface BeaconSettings {
  mode: BeaconMode;
  source: PositionKind;
  /** `fixed` mode's interval, minutes. */
  intervalMin: number;
  symbol: string;
  comment: string;
  /** On VHF, the comment rides on one beacon in this many. */
  commentEvery: number;
  /** SmartBeaconing's slow rate (below `lowSpeedKmh`) and fast rate (from `highSpeedKmh`), seconds. */
  slowRateSec: number;
  fastRateSec: number;
  gpsd: { host: string; port: number };
  nmea?: { device: string; baud: number };
}

/** SmartBeaconing's fixed settings: speeds in km/h, times in seconds, angles in degrees. */
export const SMART_BEACONING = {
  lowSpeedKmh: 5,
  highSpeedKmh: 90,
  turnMinDeg: 28,
  /** Degrees × mph: divided by the speed in mph, it adds to `turnMinDeg`. */
  turnSlopeDegMph: 255,
  turnTimeSec: 30,
} as const;
/** The rates' defaults and bounds: the slow rate in minutes, the fast rate in seconds. */
const SLOW_MIN = { def: 30, min: 1, max: 60 };
const FAST_SEC = { def: 90, min: 30, max: 600 };

/** The shortest fixed interval on VHF, minutes: a station that stands still has nothing new to say sooner. */
export const BEACON_MIN_INTERVAL_MIN = 10;
/** A moving source's fix older than this is not beaconed: the box would place itself where it was. */
const FIX_STALE_MS = 2 * 60_000;
/** How often the scheduler looks. */
const TICK_MS = 5000;

const SYMBOL_FOR: Record<PositionKind, string> = {
  fixed: "/-", // house
  termux: "/[", // a person carrying the phone
  gpsd: "/>", // car
  nmea: "/>", // car
};

/** The beacon settings from env, or null when beacons are off. Throws on a setting that cannot work. */
export function beaconSettings(env: Record<string, string | undefined>): BeaconSettings | null {
  const mode = (env.BEACON ?? "off").trim().toLowerCase();
  if (mode === "off" || mode === "") return null;
  if (mode !== "fixed" && mode !== "smart") throw new Error(`BEACON must be off, fixed or smart, not ${env.BEACON}`);
  const source = (env.BEACON_POSITION ?? "fixed").trim().toLowerCase() as PositionKind;
  if (!["fixed", "termux", "gpsd", "nmea"].includes(source))
    throw new Error(`BEACON_POSITION must be fixed, termux, gpsd or nmea, not ${env.BEACON_POSITION}`);
  const num = (k: string, def: number, min: number, max: number) => {
    const raw = env[k]?.trim();
    const n = raw ? Number(raw) : def;
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number, not ${raw}`);
    return Math.min(max, Math.max(min, n));
  };
  const symbol = env.BEACON_SYMBOL?.trim() || SYMBOL_FOR[source];
  if (!isAprsSymbol(symbol)) throw new Error(`BEACON_SYMBOL must be two characters, table then code, not ${symbol}`);
  const [host, port] = (env.BEACON_GPSD?.trim() || "127.0.0.1:2947").split(":");
  const nmeaDevice = env.BEACON_NMEA_DEVICE?.trim();
  const slowRateSec = num("BEACON_SLOW_MIN", SLOW_MIN.def, SLOW_MIN.min, SLOW_MIN.max) * 60;
  // the fast rate is never slower than the slow one
  const fastRateSec = Math.min(num("BEACON_FAST_SEC", FAST_SEC.def, FAST_SEC.min, FAST_SEC.max), slowRateSec);
  if (source === "nmea" && !nmeaDevice) throw new Error("BEACON_POSITION=nmea needs BEACON_NMEA_DEVICE");
  return {
    mode,
    source,
    intervalMin: num("BEACON_INTERVAL_MIN", 20, BEACON_MIN_INTERVAL_MIN, 24 * 60),
    symbol,
    comment: (env.BEACON_COMMENT ?? "").trim(),
    commentEvery: Math.round(num("BEACON_COMMENT_EVERY", 1, 1, 100)),
    slowRateSec,
    fastRateSec,
    gpsd: { host: host || "127.0.0.1", port: Number(port) || 2947 },
    ...(nmeaDevice ? { nmea: { device: nmeaDevice, baud: num("BEACON_NMEA_BAUD", 9600, 1200, 115_200) } } : {}),
  };
}

/** SmartBeaconing's interval at a speed, seconds, never slower than the slow rate. */
export function smartRateSec(
  speedKmh: number,
  rates: { slowRateSec: number; fastRateSec: number } = { slowRateSec: 1800, fastRateSec: 90 },
): number {
  const s = SMART_BEACONING;
  if (speedKmh < s.lowSpeedKmh) return rates.slowRateSec;
  if (speedKmh >= s.highSpeedKmh) return rates.fastRateSec;
  return Math.min(rates.slowRateSec, (rates.fastRateSec * s.highSpeedKmh) / speedKmh);
}

/** The heading change that pegs a corner at a speed, degrees. */
export function turnThresholdDeg(speedKmh: number): number {
  const mph = speedKmh / 1.609344;
  return SMART_BEACONING.turnMinDeg + SMART_BEACONING.turnSlopeDegMph / Math.max(mph, 0.1);
}

/** The smaller angle between two headings, degrees. */
const headingChange = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The port a beacon goes out on: the send of a KISS channel or a soundcard port, which applies its call gate. */
export interface BeaconPort {
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean;
  hf?: boolean;
  label?: () => string;
}

export interface BeaconSchedulerOpts {
  settings: BeaconSettings;
  source: PositionSource;
  port: BeaconPort;
  /** The station call the beacon goes out under (`BOX_CALL`). */
  call: string;
  /** The VHF path (`BOX_TX_PATH`); an HF port sends none. */
  path: string[];
  tocall?: string;
  /** The box's master transmit switch. */
  canTx: () => boolean;
  bucket: TokenBucket;
  now?: () => number;
  log?: (m: string) => void;
}

export type BeaconReason = "interval" | "rate" | "corner";

/** One port's automatic beacons. */
export class BeaconScheduler {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastCourse?: number;
  private count = 0;
  private timer?: ReturnType<typeof setInterval>;
  private heldLoggedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  /** Beacons sent, for a status line. */
  sent = 0;

  constructor(private o: BeaconSchedulerOpts) {
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? ((m) => console.log(m));
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private get moving(): boolean {
    return this.o.settings.source !== "fixed";
  }

  /** Why a beacon is due now with this fix, or null when none is. */
  due(fix: Fix, now: number): BeaconReason | null {
    const since = (now - this.lastAt) / 1000;
    // the HF preset holds whatever the mode: every station on the channel shares one 300-baud frequency
    if (this.o.port.hf && since < HF_APRS.beaconMinSec) return null;
    if (this.o.settings.mode === "fixed") return since >= this.o.settings.intervalMin * 60 ? "interval" : null;
    const speed = fix.speedKmh ?? 0;
    const s = SMART_BEACONING;
    if (
      speed >= s.lowSpeedKmh &&
      fix.course !== undefined &&
      this.lastCourse !== undefined &&
      since >= s.turnTimeSec &&
      headingChange(fix.course, this.lastCourse) > turnThresholdDeg(speed)
    )
      return "corner";
    return since >= smartRateSec(speed, this.o.settings) ? "rate" : null;
  }

  /** The frame for this fix: Mic-E on HF and for a moving source, an uncompressed position otherwise. */
  frame(fix: Fix): { src: string; dst: string; path: string[]; payload: string } {
    const { symbol, comment, commentEvery } = this.o.settings;
    const n = this.count;
    const motion = {
      ...(this.moving && fix.speedKmh !== undefined ? { speedKn: fix.speedKmh / 1.852 } : {}),
      ...(this.moving && fix.course !== undefined ? { course: fix.course } : {}),
      ...(this.moving && fix.altitudeM !== undefined ? { altitudeM: fix.altitudeM } : {}),
    };
    const src = this.o.call.toUpperCase();
    if (this.o.port.hf) {
      const b = hfBeacon(n, fix.lat, fix.lon, {
        symbol,
        comment,
        message: this.moving ? "En Route" : "In Service",
        ...motion,
      });
      return { src, dst: b.dest, path: [...HF_APRS.path], payload: b.info };
    }
    const text = n % commentEvery === 0 ? comment : "";
    if (this.moving) {
      const b = encodeMicE(fix.lat, fix.lon, { symbol, comment: text, message: "En Route", ...motion });
      return { src, dst: b.dest, path: this.o.path, payload: b.info };
    }
    return {
      src,
      dst: this.o.tocall ?? "APZACG",
      path: this.o.path,
      payload: encodeAprsPosition(fix.lat, fix.lon, symbol, text),
    };
  }

  /** Beacon when one is due and every gate is open. True when a beacon went out. */
  tick(): boolean {
    const now = this.now();
    const fix = this.o.source.latest();
    if (!fix) return false;
    if (this.moving && now - fix.at > FIX_STALE_MS) return false;
    const why = this.due(fix, now);
    if (!why) return false;
    if (!this.o.canTx()) return false;
    if (this.o.bucket.waitSec() > 0) return this.held(now, `paced, the next in ${this.o.bucket.waitSec()} s`);
    // text the box originates goes out as UTF-8 bytes
    const f = this.frame(fix);
    if (!this.o.port.send({ ...f, payload: rfBytes(f.payload) }))
      return this.held(now, "the port refused it (link down, or its transmit gate is closed)");
    this.o.bucket.take();
    this.lastAt = now;
    this.lastCourse = fix.course;
    this.count++;
    this.sent++;
    return true;
  }

  private held(now: number, why: string): false {
    if (now - this.heldLoggedAt >= 10 * 60_000) {
      this.heldLoggedAt = now;
      this.log(`[beacon] ${this.o.port.label?.() ?? "kiss"}: beacon held back: ${why}`);
    }
    return false;
  }
}
