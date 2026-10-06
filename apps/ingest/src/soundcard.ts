// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard port: a 1200-baud Bell-202 AFSK modem in the ingest box, with no TNC between the radio and
 * the box. Audio comes in through `arecord` and goes out through `aplay` (alsa.ts); the DSP is
 * `packages/aprs/src/afsk.ts`.
 *
 * Receive: PCM → `Afsk1200Rx` → AX.25 frames, delivered exactly as a KISS TNC's are (port `soundcard`, a
 * local RF transport, stamped with the receiving site when heard directly), and handed to the digipeater,
 * the IGate and the connected-mode services the same way.
 *
 * Transmit: the box's functions (digipeater, IGate, remote box, node, BBS) keep their own opt-ins and token
 * buckets and call `send` / `sendFrame` as they do on a KISS TNC. Because this port keys the radio itself,
 * it also holds the transmit gate a TNC would leave to its own firmware: a frame goes out only while
 *  - the port's transmit is on (`SOUNDCARD_TX=1`, off by default) and its PTT driver is open;
 *  - the box's master transmit switch is on (a remote "TX off" stops it);
 *  - every station call the box transmits under is control-verified at the gateway;
 *  - the port is not faulted (the PTT watchdog latched).
 * A refused frame is dropped and logged. An accepted one waits for a clear channel (carrier detect from the
 * demodulator, then p-persistence CSMA with the KISS defaults), then keys the PTT, plays the frame with its
 * TXDELAY of flags, waits for the playback to end plus TXTAIL, and unkeys. The watchdog bounds the key time.
 */
import { Afsk1200Rx, decodeAx25, encodeAx25, modulateAfsk1200 } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import { encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import type { Packet } from "@aprscaching/shared";
import {
  alsaArgs,
  alsaHint,
  defaultAudioSpawn,
  floatToS16,
  s16Reader,
  type AudioChild,
  type AudioSpawn,
} from "./alsa.js";
import { Backoff } from "./backoff.js";
import { tncPacket } from "./link.js";
import { describePtt, openPtt, type Ptt, type PttSpec } from "./ptt/index.js";
import { trackPtt, untrackPtt } from "./ptt/release.js";
import { PttWatchdog } from "./ptt/watchdog.js";

/** The ingest port every soundcard port's frames carry: a local RF transport, like `kiss-tnc`. */
export const SOUNDCARD_PORT = "soundcard";

export interface SoundcardConfig {
  /** The port's name in logs and the doctor. */
  name: string;
  /** ALSA capture device. */
  device: string;
  /** ALSA playback device. */
  playback: string;
  rate: number;
  /** The operator's transmit opt-in for this port. */
  tx: boolean;
  ptt: PttSpec;
  txDelayMs: number;
  txTailMs: number;
  /** p-persistence, 0–255: the chance (p+1)/256 of sending in a slot once the channel is clear. */
  persist: number;
  slotTimeMs: number;
  /** The PTT watchdog: the longest a transmission may hold the PTT. */
  pttMaxMs: number;
  /** Transmit audio level, 0–1 of full scale. */
  txLevel: number;
}

export interface SoundcardHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;
  onRaw?: (bytes: Uint8Array) => void;
}

export interface SoundcardGate {
  /** The box's master transmit switch. */
  master: () => boolean;
  /** The station calls this port transmits under (each must be control-verified). */
  calls: readonly string[];
  /** The first of `calls` the gateway does not know as verified, or null. */
  unverified: (calls: readonly string[]) => string | null;
}

export interface SoundcardDeps {
  spawn?: AudioSpawn;
  openPtt?: (s: PttSpec) => Promise<Ptt>;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** The receiving site this box names for frames heard directly (`RF_SITE_CALL`). */
  siteCall?: string;
}

/** Frames waiting to go out; past this a new one is refused instead of piling up behind a busy channel. */
const TX_QUEUE_MAX = 16;
/** The longest a frame waits for a clear channel before it is dropped. */
const CSMA_MAX_WAIT_MS = 30_000;
/** A repeated refusal is logged at most this often. */
const REFUSAL_LOG_MS = 60_000;

/** HDLC flags for a TXDELAY: one flag is 8 bits at 1200 baud. */
export const txDelayFlags = (ms: number) => Math.max(1, Math.ceil((ms * 1200) / 8000));

export class SoundcardPort {
  private rx: Afsk1200Rx;
  private capture: AudioChild | null = null;
  private player: AudioChild | null = null;
  private ptt: PttWatchdog | null = null;
  private pttError: string | null = null;
  private queue: Uint8Array[] = [];
  private draining = false;
  private transmitting = false;
  private stopped = false;
  private faultReason: string | null = null;
  private refusalLogged = new Map<string, number>();
  private backoff = new Backoff({ baseMs: 2000 });
  private spawn: AudioSpawn;
  private sleep: (ms: number) => Promise<void>;
  private log: (msg: string) => void;
  private error: (msg: string) => void;

  constructor(
    readonly cfg: SoundcardConfig,
    private h: SoundcardHandlers,
    private gate: SoundcardGate,
    private deps: SoundcardDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultAudioSpawn;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? ((m) => console.log(m));
    this.error = deps.error ?? ((m) => console.error(m));
    this.rx = new Afsk1200Rx(cfg.rate, (raw) => this.onRxFrame(raw));
  }

  private get tag(): string {
    return `[soundcard:${this.cfg.name}]`;
  }

  /** Open the PTT (when transmit is on) and start capturing. */
  async start(): Promise<void> {
    if (this.cfg.tx) {
      try {
        const driver = await (this.deps.openPtt ?? openPtt)(this.cfg.ptt);
        this.ptt = new PttWatchdog(driver, { maxKeyMs: this.cfg.pttMaxMs, onFault: (r) => this.onFault(r) });
        trackPtt(this.ptt);
        this.log(`${this.tag} transmit on, PTT ${driver.label}, watchdog ${this.cfg.pttMaxMs} ms`);
      } catch (e) {
        this.pttError = `PTT ${describePtt(this.cfg.ptt)} unavailable: ${(e as Error).message}`;
        this.error(`${this.tag} ${this.pttError}; the port receives only`);
      }
    } else this.log(`${this.tag} receive only (SOUNDCARD_TX=1 allows transmit)`);
    this.startCapture();
  }

  /** Stop capturing, end a playback and release the PTT. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    this.capture?.kill("SIGTERM");
    this.player?.kill("SIGKILL");
    if (this.ptt) {
      untrackPtt(this.ptt);
      await this.ptt.close().catch((e: Error) => this.error(`${this.tag} PTT close: ${e.message}`));
    }
  }

  /** Carrier detect: the channel is busy. */
  get dcd(): boolean {
    return this.rx.dcd;
  }

  /** Why the port is faulted, or null. A fault lasts until the ingest restarts. */
  get fault(): string | null {
    return this.faultReason;
  }

  /** The port as the box's status line shows it. */
  label(): string {
    return `soundcard ${this.cfg.name}${this.faultReason ? " (fault: PTT watchdog)" : ""}`;
  }

  /** Why a transmission would be refused now, or null when the gate is open. */
  txRefusal(): string | null {
    if (!this.cfg.tx) return "transmit is off on this port (set SOUNDCARD_TX=1)";
    if (this.faultReason) return `the port is faulted: ${this.faultReason}`;
    if (!this.ptt) return this.pttError ?? "no PTT driver is open";
    if (!this.gate.master()) return "transmit is switched off on this box";
    if (!this.gate.calls.length) return "no station call is set (set SOUNDCARD_CALL or BOX_CALL)";
    const unverified = this.gate.unverified(this.gate.calls);
    if (unverified) return `verify ${unverified} to transmit — control-verification required`;
    return null;
  }

  /** Transmit an AX.25 UI frame; false when the gate refuses it or the queue is full. */
  send(f: { src: string; dst: string; path?: string[]; payload: string }): boolean {
    return this.enqueue(encodeAx25(f));
  }

  /** Transmit a full AX.25 frame (connected mode: node, connected digipeater, BBS). */
  sendFrame(f: Ax25Frame): boolean {
    return this.enqueue(encodeFrame(f));
  }

  /** Push captured PCM; the capture process feeds it, and a test may too. */
  pushPcm(samples: Float32Array): void {
    this.rx.push(samples);
  }

  private enqueue(frame: Uint8Array): boolean {
    const refused = this.txRefusal();
    if (refused) {
      this.logRefusal(refused);
      return false;
    }
    if (this.queue.length >= TX_QUEUE_MAX) {
      this.logRefusal("the transmit queue is full (busy channel?)");
      return false;
    }
    this.queue.push(frame);
    void this.drain();
    return true;
  }

  private logRefusal(reason: string): void {
    const now = Date.now();
    const last = this.refusalLogged.get(reason);
    if (last !== undefined && now - last < REFUSAL_LOG_MS) return;
    this.refusalLogged.set(reason, now);
    this.log(`${this.tag} transmit refused: ${reason}`);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const frame = this.queue.shift()!;
        if (!(await this.waitForChannel())) {
          this.error(`${this.tag} channel busy for ${CSMA_MAX_WAIT_MS / 1000} s; frame dropped`);
          continue;
        }
        // the gate is checked again at the moment of keying: a remote TX off or a fault while waiting wins
        const refused = this.txRefusal();
        if (refused) {
          this.logRefusal(refused);
          this.queue = [];
          break;
        }
        await this.transmit(frame);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * p-persistence CSMA: while the carrier is detected, wait a slot; once it is clear, send with probability
   * (persist+1)/256 per slot. False when the channel stays busy past the limit.
   */
  private async waitForChannel(): Promise<boolean> {
    const random = this.deps.random ?? Math.random;
    let waited = 0;
    for (;;) {
      if (!this.rx.dcd && Math.floor(random() * 256) <= this.cfg.persist) return true;
      if (waited >= CSMA_MAX_WAIT_MS) return false;
      await this.sleep(this.cfg.slotTimeMs);
      waited += this.cfg.slotTimeMs;
    }
  }

  private async transmit(frame: Uint8Array): Promise<void> {
    const pcm = modulateAfsk1200(frame, this.cfg.rate, { flags: txDelayFlags(this.cfg.txDelayMs), amplitude: 1 });
    const airMs = (pcm.length / this.cfg.rate) * 1000 + this.cfg.txTailMs;
    if (airMs >= this.cfg.pttMaxMs) {
      this.error(
        `${this.tag} a ${Math.round(airMs)} ms transmission exceeds the PTT watchdog (SOUNDCARD_PTT_MAX_MS ${this.cfg.pttMaxMs}); frame dropped`,
      );
      return;
    }
    const ptt = this.ptt!;
    this.transmitting = true;
    try {
      await ptt.key();
      await this.play(floatToS16(pcm, this.cfg.txLevel));
      if (!this.faultReason) await this.sleep(this.cfg.txTailMs);
    } catch (e) {
      this.error(`${this.tag} transmit failed: ${(e as Error).message}`);
    } finally {
      // the watchdog already released a tripped PTT; this unkey is then a second, harmless one
      await ptt.unkey().catch((e: Error) => this.error(`${this.tag} PTT unkey failed: ${e.message}`));
      this.transmitting = false;
    }
  }

  /** Play S16 audio to the end: aplay exits once its buffer has drained. */
  private play(audio: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.spawn("aplay", alsaArgs(this.cfg.playback, this.cfg.rate));
      this.player = child;
      let stderr = "";
      let failure: Error | null = null;
      child.stderr?.on("data", (b) => (stderr += b.toString()));
      child.on("error", (e) => (failure = e));
      child.stdin?.on("error", () => {
        /* aplay exited early; its exit reports why */
      });
      child.on("exit", (code, signal) => {
        this.player = null;
        if (code === 0) resolve();
        else if (signal) reject(new Error(`playback stopped (${signal})`));
        else reject(new Error(alsaHint("aplay", failure, stderr)));
      });
      child.stdin?.write(audio);
      child.stdin?.end();
    });
  }

  private onFault(reason: string): void {
    this.faultReason = reason;
    this.queue = [];
    this.player?.kill("SIGKILL");
    this.error(`${this.tag} FAULT: ${reason}. The port stays off the air until the ingest restarts.`);
  }

  private startCapture(): void {
    if (this.stopped) return;
    const child = this.spawn("arecord", alsaArgs(this.cfg.device, this.cfg.rate));
    this.capture = child;
    const read = s16Reader();
    let stderr = "";
    let failure: Error | null = null;
    let heard = false;
    child.stdout?.on("data", (b) => {
      if (!heard) {
        heard = true;
        this.backoff.reset();
        this.log(`${this.tag} capturing ${this.cfg.device} at ${this.cfg.rate} Hz`);
      }
      this.rx.push(read(b));
    });
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => (failure = e));
    child.on("exit", () => {
      if (this.capture === child) this.capture = null;
      if (this.stopped) return;
      const wait = this.backoff.next();
      this.error(
        `${this.tag} capture ended: ${alsaHint("arecord", failure, stderr)}; retrying in ${Math.round(wait / 1000)} s`,
      );
      setTimeout(() => this.startCapture(), wait).unref?.();
    });
  }

  private onRxFrame(raw: Uint8Array): void {
    if (this.transmitting) return; // half duplex: what the card hears while we transmit is our own signal
    this.h.onRaw?.(raw);
    const f = decodeAx25(raw);
    if (!f) return;
    this.h.onFrame?.(f);
    this.h.onPacket(tncPacket(f, SOUNDCARD_PORT, this.deps.siteCall, Math.floor(Date.now() / 1000)));
  }
}
