// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  decodeAx25, decodeAprs, deframeMeshtastic, parseMeshtasticProto, type ParsedFrame, type AprsData, type MeshFix,
} from "@aprsweb/aprs";
import { Afsk1200Rx } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";
import { frameToPacket, type RfFrame, type RfLink, type TxFrame } from "./kiss.js";

/**
 * extralinks.ts — two more browser-direct RF ingests behind the same RfLink contract as the KISS
 * reader (docs/16):
 *   H4  WebAudioAfsk      — soundcard Bell-202 modem: mic → AudioContext → Afsk1200Rx → AX.25 frames.
 *   H3  WebSerialMeshtastic — a Meshtastic/LoRa node over Web Serial: deframe → POSITION_APP → fix.
 * Both stay RX-only and Tier C (no independent IGate); send() is gated off (H5). Chromium-only.
 */

export const webAudioSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia &&
  typeof (window as unknown as { AudioContext?: unknown }).AudioContext === "function";

export const webSerialSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

/** Decode a bare AX.25 frame (from the soundcard modem) to an RfFrame, or null if it isn't APRS. */
function ax25ToRfFrame(ax: Uint8Array): RfFrame | null {
  const frame = decodeAx25(ax);
  if (!frame) return null;
  try {
    const data = decodeAprs(frame);
    return { frame, data, packet: frameToPacket(frame, data, Math.floor(Date.now() / 1000)), at: Date.now() };
  } catch { return null; }
}

// ---------------------------------------------------------------- H4: soundcard AFSK
export class WebAudioAfsk implements RfLink {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;

  constructor(private onFrame: (f: RfFrame) => void, private onClose?: (e?: Error) => void) {}

  async connect(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = (window as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const rx = new Afsk1200Rx(this.ctx.sampleRate, (ax) => { const f = ax25ToRfFrame(ax); if (f) this.onFrame(f); });
    const sp = this.ctx.createScriptProcessor(4096, 1, 1); // deprecated but universally available; no module URL
    sp.onaudioprocess = (e) => rx.push(e.inputBuffer.getChannelData(0));
    const mute = this.ctx.createGain(); mute.gain.value = 0;  // keep the graph pulling without audible output/feedback
    src.connect(sp); sp.connect(mute); mute.connect(this.ctx.destination);
    this.node = sp;
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => this.onClose?.());
  }

  async send(_frame: TxFrame): Promise<void> { throw new Error("AFSK transmit is gated (H5) and not enabled here"); }

  async disconnect(): Promise<void> {
    try { this.node?.disconnect(); } catch { /* */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { await this.ctx?.close(); } catch { /* */ }
    this.ctx = null; this.stream = null; this.node = null;
  }
}

// ---------------------------------------------------------------- H3: Meshtastic over Web Serial
/** Synthesize an RfFrame from a Meshtastic position fix so it flows through the same ingest path. */
function meshFixToRfFrame(fix: MeshFix): RfFrame {
  const frame: ParsedFrame = { src: fix.node, dst: "MESH", path: [], payload: "", raw: "" };
  const data = { kind: "position", lat: fix.lat, lon: fix.lon } as unknown as AprsData;
  const packet: Packet = {
    src: fix.node, dst: "MESH", path: [], payload: "", kind: "position",
    parsed: { lat: fix.lat, lon: fix.lon, ...(fix.altitudeM != null ? { altitude: fix.altitudeM } : {}) },
    heardVia: "rf", port: "meshtastic", ts: Math.floor(Date.now() / 1000), raw: "",
  };
  return { frame, data, packet, at: Date.now() };
}

export class WebSerialMeshtastic implements RfLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private buf = new Uint8Array(0);

  constructor(private onFrame: (f: RfFrame) => void, private onClose?: (e?: Error) => void, private baudRate = 115200) {}

  async connect(): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    await this.wantConfig();   // ask the node to start streaming FromRadio frames
    this.readLoop();
  }

  /** ToRadio{ want_config_id = 3 } framed — triggers the node DB + live packet stream. */
  private async wantConfig(): Promise<void> {
    const body = Uint8Array.from([0x18, 0x01]);                    // field 3 (varint) = 1
    const frame = Uint8Array.from([0x94, 0xc3, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
    const w = this.port?.writable?.getWriter();
    if (w) { try { await w.write(frame); } finally { w.releaseLock(); } }
  }

  private async readLoop(): Promise<void> {
    while (this.port?.readable && !this.closed) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          const merged = new Uint8Array(this.buf.length + value.length);
          merged.set(this.buf); merged.set(value, this.buf.length);
          const { frames, rest } = deframeMeshtastic(merged);
          this.buf = rest.slice();
          if (this.buf.length > 8192) this.buf = new Uint8Array(0);
          for (const fr of frames) { const fix = parseMeshtasticProto(fr); if (fix) this.onFrame(meshFixToRfFrame(fix)); }
        }
      } catch (e) { if (!this.closed) this.onClose?.(e as Error); }
      finally { try { reader.releaseLock(); } catch { /* */ } }
    }
  }

  async send(_frame: TxFrame): Promise<void> { throw new Error("Meshtastic transmit is not enabled here"); }

  async disconnect(): Promise<void> {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* */ }
    try { await this.port?.close(); } catch { /* */ }
    this.port = null;
  }
}
