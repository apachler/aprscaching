// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gps.ts — where the box stands, for its automatic beacons (`BEACON_POSITION`):
 *  - `fixed`: `BOX_LAT` / `BOX_LON`, the box's configured position;
 *  - `termux`: an Android phone running the box in Termux (Pocket), through Termux:API's `termux-location`, which
 *    prints one JSON object per fix while it runs with `-r updates`;
 *  - `gpsd`: a gpsd daemon over TCP (default `127.0.0.1:2947`), asked to `?WATCH` in JSON, whose `TPV` reports
 *    carry the fix;
 *  - `nmea`: a GPS receiver on a serial port (`BEACON_NMEA_DEVICE`) talking NMEA 0183, read for its RMC and GGA
 *    sentences with the parser of @aprscaching/aprs.
 * Every source keeps its latest fix; a lost source reconnects with backoff and never stops the ingest.
 */
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { parseNmea, isValidLatLon } from "@aprscaching/aprs";
import { Backoff } from "./backoff.js";
import { LineBuffer } from "./lines.js";
import { loadSerialPort, openSerial, closeSerial, type SerialLike } from "./ptt/serialport.js";

/** One position fix. Speed in km/h, course in degrees (1–360, 360 north), time in milliseconds. */
export interface Fix {
  lat: number;
  lon: number;
  speedKmh?: number;
  course?: number;
  altitudeM?: number;
  at: number;
}

export type PositionKind = "fixed" | "termux" | "gpsd" | "nmea";

export interface PositionSource {
  readonly kind: PositionKind;
  /** The latest fix, or null before the first. */
  latest(): Fix | null;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

const MS_TO_KMH = 3.6;
const KN_TO_KMH = 1.852;
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A course as APRS writes it: 1–360, north 360; none when absent. */
const heading = (v: unknown) => (fin(v) && v >= 0 ? Math.round(v) % 360 || 360 : undefined);

function fix(lat: unknown, lon: unknown, rest: Omit<Fix, "lat" | "lon">): Fix | null {
  if (!fin(lat) || !fin(lon) || !isValidLatLon(lat, lon) || (lat === 0 && lon === 0)) return null;
  const out: Fix = { lat, lon, at: rest.at };
  if (fin(rest.speedKmh) && rest.speedKmh >= 0) out.speedKmh = rest.speedKmh;
  if (rest.course !== undefined) out.course = rest.course;
  if (fin(rest.altitudeM)) out.altitudeM = rest.altitudeM;
  return out;
}

/** A `termux-location` report: `latitude`, `longitude`, `altitude` (m), `bearing` (°), `speed` (m/s). */
export function parseTermuxLocation(o: unknown, at: number): Fix | null {
  const r = o as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const speed = fin(r.speed) ? r.speed * MS_TO_KMH : undefined;
  // Android reports bearing 0 for a fix without one; a phone at rest has no course
  const course = speed && speed > 0 && fin(r.bearing) ? heading(r.bearing) : undefined;
  return fix(r.latitude, r.longitude, { at, speedKmh: speed, course, altitudeM: r.altitude as number });
}

/**
 * The JSON objects in `termux-location`'s output, as they complete: it pretty-prints each fix over several lines,
 * so the splitter counts braces (outside strings) instead of reading lines. Bounded: a run of text with no object
 * end is dropped past 16 KB.
 */
export class JsonObjectSplitter {
  private buf = "";
  private depth = 0;
  private inStr = false;
  private esc = false;

  push(chunk: string): unknown[] {
    const out: unknown[] = [];
    for (const ch of chunk) {
      if (this.depth === 0 && ch !== "{") continue;
      this.buf += ch;
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === "\\") this.esc = true;
        else if (ch === '"') this.inStr = false;
      } else if (ch === '"') this.inStr = true;
      else if (ch === "{") this.depth++;
      else if (ch === "}" && --this.depth === 0) {
        try {
          out.push(JSON.parse(this.buf));
        } catch {
          // not JSON after all: dropped
        }
        this.buf = "";
      }
      if (this.buf.length > 16_384) {
        this.buf = "";
        this.depth = 0;
        this.inStr = false;
      }
    }
    return out;
  }
}

/** A gpsd JSON line: a `TPV` report with a 2D or 3D fix (`mode` 2 or 3); speed in m/s, `track` in degrees. */
export function parseGpsdLine(line: string, at: number): Fix | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || o.class !== "TPV" || !fin(o.mode) || o.mode < 2) return null;
  const speed = fin(o.speed) ? o.speed * MS_TO_KMH : undefined;
  return fix(o.lat, o.lon, {
    at,
    speedKmh: speed,
    course: speed && speed > 0 ? heading(o.track) : undefined,
    altitudeM: (fin(o.altMSL) ? o.altMSL : o.alt) as number,
  });
}

/**
 * NMEA sentences into fixes: an RMC gives the position, speed and course, and the altitude of the latest GGA
 * joins it. A GGA alone (a receiver that sends no RMC) is a fix without speed.
 */
export class NmeaFixer {
  private altitudeM?: number;
  private rmcSeen = false;

  line(s: string, at: number): Fix | null {
    const r = parseNmea(s.trim());
    if (!r) return null;
    if (r.sentence === "GGA") {
      this.altitudeM = r.altitudeM;
      return this.rmcSeen ? null : fix(r.lat, r.lon, { at, altitudeM: r.altitudeM });
    }
    if (r.sentence !== "RMC") return null;
    this.rmcSeen = true;
    const speed = r.speedKn !== undefined ? r.speedKn * KN_TO_KMH : undefined;
    return fix(r.lat, r.lon, {
      at,
      speedKmh: speed,
      course: speed && speed > 0 ? r.course : undefined,
      altitudeM: this.altitudeM,
    });
  }
}

/** The box's configured position: a fix that never moves. */
export class FixedSource implements PositionSource {
  readonly kind = "fixed";
  constructor(private at: { lat: number; lon: number }) {}
  latest(): Fix {
    return { lat: this.at.lat, lon: this.at.lon, speedKmh: 0, at: Date.now() };
  }
  start(): void {}
  stop(): void {}
}

abstract class LiveSource implements PositionSource {
  abstract readonly kind: PositionKind;
  protected last: Fix | null = null;
  protected stopped = false;
  protected backoff = new Backoff({ baseMs: 5000, capMs: 120_000 });
  private timer?: ReturnType<typeof setTimeout>;
  constructor(protected log: (m: string) => void = (m) => console.log(m)) {}
  latest(): Fix | null {
    return this.last;
  }
  protected got(f: Fix | null): void {
    if (!f) return;
    if (!this.last) this.log(`[beacon] first ${this.kind} fix ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`);
    this.last = f;
    this.backoff.reset();
  }
  protected again(why: string): void {
    if (this.stopped || this.timer) return;
    const ms = this.backoff.next();
    this.log(`[beacon] ${this.kind} position source ${why}; retrying in ${Math.round(ms / 1000)} s`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.start();
    }, ms);
    this.timer.unref?.();
  }
  abstract start(): void | Promise<void>;
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Termux:API on the Pocket phone: `termux-location -p gps -r updates`, restarted when it exits. */
export class TermuxSource extends LiveSource {
  readonly kind = "termux";
  private child?: ChildProcess;
  constructor(
    log?: (m: string) => void,
    private spawnFn: typeof spawn = spawn,
  ) {
    super(log);
  }
  start(): void {
    if (this.stopped) return;
    const split = new JsonObjectSplitter();
    let child: ChildProcess;
    try {
      child = this.spawnFn("termux-location", ["-p", "gps", "-r", "updates"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.again(`cannot start termux-location (${(e as Error).message})`);
      return;
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      for (const o of split.push(c)) this.got(parseTermuxLocation(o, Date.now()));
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      this.again(
        e.code === "ENOENT"
          ? "is missing: install the Termux:API app and `pkg install termux-api`"
          : `failed (${e.message})`,
      ),
    );
    child.on("exit", (code) => this.again(`exited (${code ?? "signal"})`));
  }
  stop(): void {
    super.stop();
    this.child?.kill();
  }
}

/** A gpsd daemon: `?WATCH={"enable":true,"json":true}`, then one JSON report per line. */
export class GpsdSource extends LiveSource {
  readonly kind = "gpsd";
  private sock?: net.Socket;
  constructor(
    private host: string,
    private port: number,
    log?: (m: string) => void,
  ) {
    super(log);
  }
  start(): void {
    if (this.stopped) return;
    const lines = new LineBuffer();
    const s = net.connect(this.port, this.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => s.write('?WATCH={"enable":true,"json":true}\n'));
    s.on("data", (c: string) => {
      for (const l of lines.push(c)) this.got(parseGpsdLine(l, Date.now()));
    });
    s.on("error", () => {
      /* close follows */
    });
    s.on("close", () => this.again(`at ${this.host}:${this.port} closed`));
  }
  stop(): void {
    super.stop();
    this.sock?.destroy();
  }
}

/** A serial NMEA GPS receiver (`BEACON_NMEA_DEVICE` at `BEACON_NMEA_BAUD`), through the optional `serialport`. */
export class NmeaSource extends LiveSource {
  readonly kind = "nmea";
  private port?: SerialLike;
  constructor(
    private device: string,
    private baud: number,
    log?: (m: string) => void,
  ) {
    super(log);
  }
  async start(): Promise<void> {
    if (this.stopped) return;
    const lines = new LineBuffer();
    const fixer = new NmeaFixer();
    try {
      const port = await openSerial(await loadSerialPort(), this.device, this.baud, "beacon");
      this.port = port;
      port.on("data", (b: Buffer) => {
        for (const l of lines.push(b.toString("latin1"))) this.got(fixer.line(l, Date.now()));
      });
      port.on("close", () => this.again(`${this.device} closed`));
    } catch (e) {
      this.again(`cannot read ${this.device} (${(e as Error).message})`);
    }
  }
  stop(): void {
    super.stop();
    if (this.port) void closeSerial(this.port);
  }
}
