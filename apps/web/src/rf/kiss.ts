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

/**
 * Web Serial KISS reader. Reassembles KISS frames from the serial stream (split on FEND 0xC0,
 * matching apps/ingest), decodes each, and emits an RfFrame. Auto-cleans on disconnect.
 */
export class WebSerialKiss {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buf: number[] = [];
  private closed = false;

  constructor(private onFrame: (f: RfFrame) => void, private onClose?: (err?: Error) => void) {}

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

  private feed(chunk: Uint8Array): void {
    for (const b of chunk) this.buf.push(b);
    const lastFend = this.buf.lastIndexOf(0xc0);
    if (lastFend <= 0) return;                              // wait for a complete frame
    const ready = Uint8Array.from(this.buf.slice(0, lastFend + 1));
    this.buf = this.buf.slice(lastFend + 1);
    for (const f of decodeKissBuffer(ready, Date.now())) this.onFrame(f);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.port?.close(); } catch { /* ignore */ }
    this.port = null;
    this.onClose?.();
  }
}

/** The slice of the Web Serial port API we use (avoids a @types/w3c-web-serial dependency). */
interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
