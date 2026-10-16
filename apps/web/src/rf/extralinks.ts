// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  deframeMeshtastic,
  parseFromRadio,
  wantConfigFrame,
  MeshtasticLicensedNodes,
  type ParsedFrame,
  type AprsData,
  type MeshFix,
} from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import type { RfFrame, RfLink, TxFrame } from "./kiss.js";

/**
 * extralinks.ts — the Meshtastic link and the Web Audio check for the soundcard link (`soundcard.ts`):
 *   WebSerialMeshtastic — a Meshtastic/LoRa node over Web Serial: deframe → FromRadio → positions of
 *                         licensed nodes only, under their callsigns.
 * It stays RX-only and Tier C (a browser is never an attested receiving site). Chromium-only.
 */

export const webAudioSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof (window as unknown as { AudioContext?: unknown }).AudioContext === "function";

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- Meshtastic over Web Serial
/**
 * Synthesize an RfFrame from a licensed Meshtastic node's position, under its callsign, so it flows
 * through the same ingest path. Trust-neutral like every Meshtastic path (`aprs_is`): a Meshtastic
 * hearing is never attestable RF evidence.
 */
function meshFixToRfFrame(fix: MeshFix, call: string): RfFrame {
  const frame: ParsedFrame = { src: call, dst: "MESH", path: [], payload: "", raw: "" };
  const data = { kind: "position", lat: fix.lat, lon: fix.lon } as unknown as AprsData;
  const packet: Packet = {
    src: call,
    dst: "MESH",
    path: [],
    payload: "",
    kind: "position",
    parsed: { lat: fix.lat, lon: fix.lon, ...(fix.altitudeM != null ? { altitude: fix.altitudeM } : {}) },
    heardVia: "aprs_is",
    port: "meshtastic",
    ts: Math.floor(Date.now() / 1000),
    raw: "",
  };
  return { frame, data, packet, at: Date.now() };
}

export class WebSerialMeshtastic implements RfLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private buf = new Uint8Array(0);
  /** Only licensed nodes enter the map; their callsigns are learned from NodeInfo. */
  private licensed = new MeshtasticLicensedNodes();

  constructor(
    private onFrame: (f: RfFrame) => void,
    private onClose?: (e?: Error) => void,
    private baudRate = 115200,
  ) {}

  async connect(): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    await this.wantConfig(); // ask the node to start streaming FromRadio frames
    void this.readLoop();
  }

  /** ToRadio{ want_config_id } — triggers the node database (with licence flags) + the live packet stream. */
  private async wantConfig(): Promise<void> {
    const frame = wantConfigFrame();
    const w = this.port?.writable?.getWriter();
    if (w) {
      try {
        await w.write(frame);
      } finally {
        w.releaseLock();
      }
    }
  }

  /** Read until disconnect() or the link fails; a failed read ends the session like a failed KISS read. */
  private async readLoop(): Promise<void> {
    let err: Error | undefined;
    while (this.port?.readable && !this.closed && !err) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          const merged = new Uint8Array(this.buf.length + value.length);
          merged.set(this.buf);
          merged.set(value, this.buf.length);
          const { frames, rest } = deframeMeshtastic(merged);
          this.buf = rest.slice();
          if (this.buf.length > 8192) this.buf = new Uint8Array(0);
          for (const fr of frames) {
            const ev = parseFromRadio(fr);
            this.licensed.observe(ev);
            if (ev?.kind !== "position") continue;
            const call = this.licensed.callsignFor(ev.fix.node);
            if (call) this.onFrame(meshFixToRfFrame(ev.fix, call)); // unlicensed or not yet known → dropped
          }
        }
      } catch (e) {
        err = e as Error;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* */
        }
        this.reader = null;
      }
    }
    if (this.closed) return;
    // A lost link closes the port before it is reported, so the next connect can open it again.
    await this.disconnect();
    this.onClose?.(err);
  }

  async send(_frame: TxFrame): Promise<void> {
    throw new Error("Meshtastic transmit is not enabled here");
  }

  /** Close the port; safe to call again on a port that is already closed. */
  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* */
    }
    try {
      await this.port?.close();
    } catch {
      /* */
    }
    this.port = null;
  }
}
