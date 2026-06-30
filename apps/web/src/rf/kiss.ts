/**
 * kiss.ts — browser-direct RF ingest over Web Serial (docs/16 H1, ingest-locality.md).
 *
 * A USB KISS TNC (DigiRig, NinoTNC, Mobilinkd, Kenwood TH-D74/75, …) plugged into Chromium becomes
 * a first-class RF ingest with no server and no install. We reuse the pure @aprsweb/aprs codec
 * (KISS reassembly + AX.25 + APRS decode) — the same code the operator-local apps/ingest runs — so a
 * frame heard here decodes identically. Chromium-only + session-bound; callers MUST feature-detect
 * and provide a non-RF fallback.
 *
 * Trust note (docs/22): a frame heard directly on the operator's own radio has no independent IGate,
 * so the provenance derivation keeps it Tier C — a browser receiver can't self-corroborate to Tier A.
 */
import { kissFrames, decodeAx25, decodeAprs, type ParsedFrame, type AprsData } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

/** Is browser-direct RF available here? (Web Serial — Chromium desktop, secure context.) */
export const webSerialSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

export interface RfFrame { frame: ParsedFrame; data: AprsData; packet: Packet; at: number }

const POS_KINDS = new Set(["position", "object", "item", "weather"]);
const PKT_KINDS = new Set(["position", "message", "weather", "telemetry", "status", "object", "item"]);

/** Map a decoded RF frame to the ingest Packet (heard directly on the radio → heardVia 'rf', no IGate). */
export function frameToPacket(frame: ParsedFrame, data: AprsData, atSec: number): Packet {
  const d = data as AprsData & { lat?: number; lon?: number; symbol?: { table: string; code: string } };
  const parsed = POS_KINDS.has(data.kind) && typeof d.lat === "number"
    ? { lat: d.lat, lon: d.lon, symbol: d.symbol ? `${d.symbol.table}${d.symbol.code}` : undefined }
    : undefined;
  return {
    src: frame.src, dst: frame.dst, path: frame.path, payload: frame.payload,
    kind: (PKT_KINDS.has(data.kind) ? data.kind : "other") as Packet["kind"],
    parsed,
    heardVia: "rf", port: "webserial-kiss", ts: atSec, raw: frame.raw,
  };
}

/** Decode a complete KISS byte buffer into RF frames (pure; the testable core of the reader). */
export function decodeKissBuffer(buf: Uint8Array, atMs: number): RfFrame[] {
  const out: RfFrame[] = [];
  for (const raw of kissFrames(buf)) {
    const frame = decodeAx25(raw);
    if (!frame) continue;
    try {
      const data = decodeAprs(frame);
      out.push({ frame, data, packet: frameToPacket(frame, data, Math.floor(atMs / 1000)), at: atMs });
    } catch { /* skip a malformed frame, keep the stream alive */ }
  }
  return out;
}

/** A KISS byte feeder: buffers a stream and emits RfFrames on each complete FEND-delimited frame. */
function makeFeeder(onFrame: (f: RfFrame) => void): (chunk: Uint8Array) => void {
  let buf: number[] = [];
  return (chunk) => {
    for (const b of chunk) buf.push(b);
    const lastFend = buf.lastIndexOf(0xc0);
    if (lastFend <= 0) return;                              // wait for a complete frame
    const ready = Uint8Array.from(buf.slice(0, lastFend + 1));
    buf = buf.slice(lastFend + 1);
    for (const f of decodeKissBuffer(ready, Date.now())) onFrame(f);
  };
}

/** A live RF link; both Web Serial and Web Bluetooth implement it. */
export interface RfLink { disconnect(): Promise<void> }

/**
 * Web Serial KISS reader. Reassembles KISS frames from the serial stream (split on FEND 0xC0,
 * matching apps/ingest), decodes each, and emits an RfFrame. Auto-cleans on disconnect.
 */
export class WebSerialKiss implements RfLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private feed: (chunk: Uint8Array) => void;

  constructor(onFrame: (f: RfFrame) => void, private onClose?: (err?: Error) => void) { this.feed = makeFeeder(onFrame); }

  /** Prompt the user to pick a serial port (requires a user gesture) and start reading. */
  async connect(baudRate = 9600): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate });
    this.closed = false;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    let err: Error | undefined;
    try {
      while (this.port?.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.feed(value);
          }
        } finally { this.reader.releaseLock(); this.reader = null; }
      }
    } catch (e) { err = e as Error; }
    finally { if (!this.closed) this.onClose?.(err); }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.port?.close(); } catch { /* ignore */ }
    this.port = null;
    this.onClose?.();
  }
}

// ---- H2: BLE-KISS over Web Bluetooth (Mobilinkd TNC4 & friends use the Nordic UART Service) ----
const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // device → host notifications (KISS bytes)

/** Is browser-direct RF available over Bluetooth? (Web Bluetooth — Chromium, secure context.) */
export const webBluetoothSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof (navigator as { bluetooth?: { requestDevice?: unknown } }).bluetooth?.requestDevice === "function";

/**
 * BLE-KISS reader. Connects a Bluetooth TNC over the Nordic UART Service, subscribes to the RX
 * characteristic, reassembles KISS frames and emits RfFrames — same decode pipeline as serial.
 */
export class WebBluetoothKiss implements RfLink {
  private device: BleDeviceLike | null = null;
  private char: BleCharLike | null = null;
  private closed = false;
  private feed: (chunk: Uint8Array) => void;
  private readonly onValue = (ev: Event) => {
    const v = (ev.target as { value?: DataView }).value;
    if (v) this.feed(new Uint8Array(v.buffer));
  };

  constructor(onFrame: (f: RfFrame) => void, private onClose?: (err?: Error) => void) { this.feed = makeFeeder(onFrame); }

  /** Prompt the user to pick a BLE TNC (requires a user gesture) and start reading. */
  async connect(): Promise<void> {
    const bt = (navigator as unknown as { bluetooth: { requestDevice(o: unknown): Promise<BleDeviceLike> } }).bluetooth;
    this.device = await bt.requestDevice({ filters: [{ services: [NUS_SERVICE] }], optionalServices: [NUS_SERVICE] });
    this.device.addEventListener?.("gattserverdisconnected", () => { if (!this.closed) this.onClose?.(); });
    const gatt = await this.device.gatt.connect();
    const svc = await gatt.getPrimaryService(NUS_SERVICE);
    this.char = await svc.getCharacteristic(NUS_RX_NOTIFY);
    this.char.addEventListener("characteristicvaluechanged", this.onValue);
    await this.char.startNotifications();
    this.closed = false;
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try { this.char?.removeEventListener("characteristicvaluechanged", this.onValue); } catch { /* ignore */ }
    try { await this.char?.stopNotifications(); } catch { /* ignore */ }
    try { this.device?.gatt.disconnect(); } catch { /* ignore */ }
    this.device = null; this.char = null;
    this.onClose?.();
  }
}

/** Minimal slices of the Web Serial / Web Bluetooth APIs we use (avoids extra @types deps). */
interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
interface BleCharLike {
  startNotifications(): Promise<unknown>; stopNotifications(): Promise<unknown>;
  addEventListener(t: string, fn: (e: Event) => void): void; removeEventListener(t: string, fn: (e: Event) => void): void;
}
interface BleGattLike { connect(): Promise<{ getPrimaryService(u: string): Promise<{ getCharacteristic(u: string): Promise<BleCharLike> }> }>; disconnect(): void }
interface BleDeviceLike { gatt: BleGattLike; addEventListener?(t: string, fn: () => void): void }
