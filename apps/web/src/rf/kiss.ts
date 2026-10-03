// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * kiss.ts — browser-direct RF ingest over Web Serial and Web Bluetooth.
 *
 * A USB KISS TNC (DigiRig, NinoTNC, Mobilinkd, Kenwood TH-D74/75, …) plugged into Chromium becomes
 * a first-class RF ingest with no server and no install; so does a Bluetooth LE KISS TNC (bleKiss.ts). We reuse the pure @aprscaching/aprs codec
 * (KISS reassembly + AX.25 + APRS decode) — the same code the operator-local apps/ingest runs — so a
 * frame heard here decodes identically. Chromium-only + session-bound; callers MUST feature-detect
 * and provide a non-RF fallback.
 *
 * Trust note: only a receiving site this instance attests, delivering through its own ingest, carries
 * first-party attestation. A frame the browser heard is not attested, so the provenance derivation keeps it
 * Tier C — a browser receiver can't self-corroborate to Tier A.
 */
import {
  KissDecoder,
  type KissFrame,
  decodeAx25,
  decodeAprs,
  encodeAx25,
  kissWrap,
  type ParsedFrame,
  type AprsData,
} from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { BleKissLink } from "./bleKiss.js";

/** A frame to transmit. src is the operator's verified callsign+SSID; dst is the TOCALL. */
export interface TxFrame {
  src: string;
  dst: string;
  path?: string[];
  payload: string;
}

/** Is browser-direct RF available here? (Web Serial — Chromium desktop, secure context.) */
export const webSerialSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

export interface RfFrame {
  frame: ParsedFrame;
  data: AprsData;
  packet: Packet;
  at: number;
}

const POS_KINDS = new Set(["position", "object", "item", "weather"]);
const PKT_KINDS = new Set(["position", "message", "weather", "telemetry", "status", "object", "item"]);

/** Map a decoded RF frame to the ingest Packet (heard directly on the radio → heardVia 'rf', no IGate). */
export function frameToPacket(frame: ParsedFrame, data: AprsData, atSec: number): Packet {
  const d = data as AprsData & { lat?: number; lon?: number; symbol?: { table: string; code: string } };
  const parsed =
    POS_KINDS.has(data.kind) && typeof d.lat === "number"
      ? { lat: d.lat, lon: d.lon, symbol: d.symbol ? `${d.symbol.table}${d.symbol.code}` : undefined }
      : undefined;
  return {
    src: frame.src,
    dst: frame.dst,
    path: frame.path,
    payload: frame.payload,
    kind: (PKT_KINDS.has(data.kind) ? data.kind : "other") as Packet["kind"],
    parsed,
    heardVia: "rf",
    port: "webserial-kiss",
    ts: atSec,
    raw: frame.raw,
  };
}

/** Decode KISS data frames into RF frames (pure; the testable core of the reader). */
function decodeKissFrames(frames: KissFrame[], atMs: number): RfFrame[] {
  const out: RfFrame[] = [];
  for (const k of frames) {
    if (k.command !== 0) continue; // a KISS command, not a frame
    const frame = decodeAx25(k.frame);
    if (!frame) continue;
    try {
      const data = decodeAprs(frame);
      out.push({ frame, data, packet: frameToPacket(frame, data, Math.floor(atMs / 1000)), at: atMs });
    } catch {
      /* skip a malformed frame, keep the stream alive */
    }
  }
  return out;
}

/** A KISS byte feeder: buffers a stream and emits RfFrames on each complete FEND-delimited frame. */
function makeFeeder(onFrame: (f: RfFrame) => void): (chunk: Uint8Array) => void {
  const rx = new KissDecoder();
  return (chunk) => {
    for (const f of decodeKissFrames(rx.push(chunk), Date.now())) onFrame(f);
  };
}

/** A live RF link; both Web Serial and Web Bluetooth implement it. */
export interface RfLink {
  disconnect(): Promise<void>;
  /** Transmit a frame (gated UI-side on callsign control-verification + opt-in). May throw if RX-only. */
  send(frame: TxFrame): Promise<void>;
}

/**
 * Web Serial KISS reader. Reassembles KISS frames from the serial stream (split on FEND 0xC0,
 * matching apps/ingest), decodes each, and emits an RfFrame. Auto-cleans on disconnect.
 */
export class WebSerialKiss implements RfLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private feed: (chunk: Uint8Array) => void;

  constructor(
    onFrame: (f: RfFrame) => void,
    private onClose?: (err?: Error) => void,
  ) {
    this.feed = makeFeeder(onFrame);
  }

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
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (e) {
      err = e as Error;
    }
    if (this.closed) return;
    // A lost link closes the port before it is reported, so the next connect can open it again.
    await this.close();
    this.onClose?.(err);
  }

  /** Transmit a frame over the serial port (gated on callsign control-verification). Throws if the port has no writable stream. */
  async send(frame: TxFrame): Promise<void> {
    if (!this.port?.writable) throw new Error("port is not writable");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(kissWrap(encodeAx25(frame)));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect(): Promise<void> {
    await this.close();
    this.onClose?.();
  }

  /** Stop reading and close the port; safe to call again on a port that is already closed. */
  private async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }
}

export { webBluetoothSupported } from "./bleKiss.js";

/**
 * BLE-KISS reader. Connects a Bluetooth TNC over whichever KISS service it offers (the BLE KISS API that
 * Mobilinkd TNCs use, or the Nordic UART Service), reassembles KISS frames from the notifications and emits
 * RfFrames — the same decode pipeline as serial.
 */
export class WebBluetoothKiss implements RfLink {
  private link: BleKissLink;

  constructor(
    onFrame: (f: RfFrame) => void,
    private onClose?: (err?: Error) => void,
  ) {
    this.link = new BleKissLink(makeFeeder(onFrame), () => this.onClose?.(new Error("the Bluetooth TNC disconnected")));
  }

  /** Prompt the user to pick a BLE TNC (requires a user gesture) and start reading. */
  async connect(): Promise<void> {
    await this.link.connect();
  }

  /** Transmit a frame over BLE (gated on callsign control-verification). Throws if the TNC is receive-only. */
  async send(frame: TxFrame): Promise<void> {
    await this.link.write(kissWrap(encodeAx25(frame)));
  }

  async disconnect(): Promise<void> {
    await this.link.disconnect();
    this.onClose?.();
  }
}

/** Minimal slice of the Web Serial API we use (avoids extra @types deps). */
interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
