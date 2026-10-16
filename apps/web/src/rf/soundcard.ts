// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard link: a radio's audio through the microphone or line-in, demodulated as 1200-baud Bell 202 or
 * 300-baud HF AFSK. Behind the same RfLink contract as the KISS reader.
 *
 * The page only wires the audio graph: microphone → AudioWorklet tap → modem Worker (`soundcard.worker.ts`,
 * Direwolf's WebAssembly modem, or the built-in one) → AX.25 frames back here. The Worker and its WebAssembly
 * are fetched only when the link connects, so no other view carries them. An engine without AudioWorklet taps
 * the samples with a ScriptProcessorNode on the page and hands them to the same Worker.
 *
 * The link only receives, and what it hears stays Tier C: a browser is never an attested receiving site.
 */
import { decodeAx25, decodeAprs, rfText } from "@aprscaching/aprs";
import { frameToPacket, type RfFrame, type RfLink, type TxFrame } from "./kiss.js";
import {
  TAP_BLOCK,
  TAP_WORKLET,
  isModemReply,
  modemNote,
  type AudioBaud,
  type AudioDemod,
  type ModemStart,
} from "./soundcardModem.js";

/** Decode a bare AX.25 frame (from the soundcard modem) to an RfFrame, or null if it isn't APRS. */
function ax25ToRfFrame(ax: Uint8Array): RfFrame | null {
  const frame = decodeAx25(ax);
  if (!frame) return null;
  try {
    const data = decodeAprs({ ...frame, payload: rfText(frame.payload) });
    return { frame, data, packet: frameToPacket(frame, data, Math.floor(Date.now() / 1000)), at: Date.now() };
  } catch {
    return null;
  }
}

export interface SoundcardOptions {
  baud: AudioBaud;
  demod: AudioDemod;
  /** The modem Worker; defaults to the one the app's build emits. */
  makeWorker?: () => Worker;
  /** How long the modem may take to start before the connect fails. */
  startTimeoutMs?: number;
}

const appWorker = () => new Worker(new URL("./soundcard.worker.ts", import.meta.url), { type: "module" });

export class SoundcardLink implements RfLink {
  /** The modem in a few words, once the link is up. */
  note = "";
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private channel: MessageChannel | null = null;
  private tap: AudioNode | null = null;
  private closed = false;

  constructor(
    private onFrame: (f: RfFrame) => void,
    private onClose: ((e?: Error) => void) | undefined,
    private opts: SoundcardOptions,
  ) {}

  async connect(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      this.ctx = new AudioContext();
      this.channel = new MessageChannel();
      await this.startModem(this.ctx.sampleRate, this.channel.port2);
      await this.startTap(this.ctx, this.stream, this.channel.port1);
    } catch (e) {
      await this.disconnect();
      throw e;
    }
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => this.lost());
  }

  /** Start the modem Worker and wait until it reports which modem runs. */
  private startModem(sampleRate: number, samples: MessagePort): Promise<void> {
    const worker = (this.opts.makeWorker ?? appWorker)();
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => reject(new Error("the soundcard modem did not start")),
        this.opts.startTimeoutMs ?? 20_000,
      );
      worker.onmessage = (e: MessageEvent) => {
        const m: unknown = e.data;
        if (!isModemReply(m)) return;
        if (m.type === "ready") {
          ready = true;
          clearTimeout(timer);
          this.note = modemNote(m);
          resolve();
        } else if (m.type === "failed") {
          clearTimeout(timer);
          reject(new Error(`the soundcard modem did not start: ${m.message}`));
        } else
          for (const ax of m.frames) {
            const f = ax25ToRfFrame(ax.bytes);
            if (f) this.onFrame(f);
          }
      };
      worker.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        const err = new Error(`the soundcard modem stopped: ${e.message || "the Worker failed"}`);
        if (ready) this.lost(err);
        else {
          clearTimeout(timer);
          reject(err);
        }
      };
      const start: ModemStart = {
        type: "start",
        sampleRate,
        baud: this.opts.baud,
        demod: this.opts.demod,
        samples,
      };
      worker.postMessage(start, [samples]);
    });
  }

  /** Tap the microphone: an AudioWorklet posting straight to the modem, or a ScriptProcessorNode on the page. */
  private async startTap(ctx: AudioContext, stream: MediaStream, out: MessagePort): Promise<void> {
    const src = ctx.createMediaStreamSource(stream);
    // the graph must reach the destination to be pulled; a muted gain keeps the radio's audio out of the speakers
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    if (ctx.audioWorklet && typeof AudioWorkletNode === "function") {
      try {
        const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(ctx, "acs-modem-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.postMessage(out, [out]);
        src.connect(node);
        node.connect(mute);
        this.tap = node;
        return;
      } catch {
        /* an engine that refuses the worklet taps on the page instead */
      }
    }
    const sp = ctx.createScriptProcessor(TAP_BLOCK, 1, 1);
    sp.onaudioprocess = (e) => {
      const block = new Float32Array(e.inputBuffer.getChannelData(0));
      out.postMessage(block, [block.buffer]);
    };
    src.connect(sp);
    sp.connect(mute);
    this.tap = sp;
  }

  private lost(err?: Error): void {
    if (this.closed) return;
    void this.disconnect();
    this.onClose?.(err);
  }

  async send(_frame: TxFrame): Promise<void> {
    throw new Error("The soundcard link only receives: connect a USB or Bluetooth TNC to transmit");
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      this.tap?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.worker?.terminate();
    this.channel?.port1.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      await this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.stream = null;
    this.worker = null;
    this.channel = null;
    this.tap = null;
  }
}
