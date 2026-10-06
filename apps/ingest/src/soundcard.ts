// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard port: a 1200-baud Bell-202 AFSK modem in the ingest box, with no TNC between the radio and
 * the box. Audio comes in through `arecord` and goes out through `aplay` (alsa.ts); the DSP is
 * `packages/aprs/src/afsk.ts`.
 *
 * Receive: PCM → `Afsk1200Rx` → AX.25 frames, delivered as a KISS TNC's are (port `soundcard`, a local RF
 * transport, stamped with the receiving site when heard directly), and handed to the digipeater, the IGate
 * and the connected-mode services the same way. The port's own transmissions never come back as hearings:
 * frames decoded while it transmits, or within the capture latency after it unkeys, are dropped, the
 * demodulator starts afresh at every unkey, and a frame byte-identical to one the box sent on any of its ports in
 * the last 30 s is dropped too (echo.ts). An attested site must not attest its own signal.
 *
 * Transmit: the box's functions (digipeater, IGate, remote box, node, BBS) keep their own opt-ins and token
 * buckets and call `send` / `sendFrame`, as they do on the KISS TNC; every RF transmit port shares the box's
 * call gate (callverify.ts). This port keys the radio itself, so it adds what a TNC's firmware would hold:
 * a frame goes out only while
 *  - the port's transmit is on (`SOUNDCARD_TX=1`, off by default) and its PTT driver is open;
 *  - the box's master transmit switch is on (a remote "TX off" stops it);
 *  - the gateway confirms every station call the box transmits under (control-verified, the box's operator's);
 *  - capture runs (carrier detect needs it), and the port is not faulted (the PTT watchdog latched).
 * A refused frame is dropped and logged. An accepted one waits for a clear channel (carrier detect from the
 * demodulator, then p-persistence CSMA with the KISS defaults) and for the duty-cycle budget, then keys the
 * PTT, plays the frame with its TXDELAY of flags, waits for the playback to end plus TXTAIL, and unkeys. A
 * frame that waited 30 s is dropped. The watchdog bounds the key time.
 */
import { Afsk1200Rx, decodeAx25, encodeAx25, modulateAfsk1200 } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import { encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import type { Packet } from "@aprscaching/shared";
import { SentFrames } from "./echo.js";
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
import { releaseAllSync, trackPtt, untrackPtt } from "./ptt/release.js";
import { PttWatchdog, withTimeout } from "./ptt/watchdog.js";

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
  /** The most of any 60 s the port may transmit, in percent. */
  dutyPct: number;
}

export interface SoundcardHandlers {
  onPacket: (p: Packet) => void;
  onFrame?: (f: ParsedFrame) => void;
  onRaw?: (bytes: Uint8Array) => void;
}

export interface SoundcardGate {
  /** The box's master transmit switch. */
  master: () => boolean;
  /** The station calls this port transmits under. */
  calls: readonly string[];
  /** Why the box may not transmit under `calls` now (callverify.ts), or null. */
  refusal: (calls: readonly string[]) => string | null;
}

export interface SoundcardDeps {
  spawn?: AudioSpawn;
  openPtt?: (s: PttSpec) => Promise<Ptt>;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** The receiving site this box names for frames heard directly (`RF_SITE_CALL`). */
  siteCall?: string;
  /** No PCM for this long restarts capture (default 5 s). */
  stallMs?: number;
  /** The frames the box sent on any port, shared by all of them; the port keeps its own when none is given. */
  sent?: SentFrames;
}

/** Frames waiting to go out; past this a new one is refused instead of piling up behind a busy channel. */
const TX_QUEUE_MAX = 16;
/** A frame queued longer than this is dropped: a late digipeat or answer is worse than none. */
const TX_MAX_AGE_MS = 30_000;
/** The duty-cycle window. */
const DUTY_WINDOW_MS = 60_000;
/** A repeated refusal is logged at most this often. */
const REFUSAL_LOG_MS = 60_000;
/**
 * How long after an unkey a decoded frame still counts as the port's own signal: arecord's default buffer is
 * half a second, and the pipe and the demodulator's window add a little.
 */
export const RX_GUARD_MS = 600;
/** How long stop() waits for a transmission in progress before it releases the PTT anyway. */
const STOP_WAIT_MS = 3000;
/** A playback may overrun its airtime by this much before it is killed. */
const PLAY_SLACK_MS = 2000;

/** HDLC flags for a TXDELAY: one flag is 8 bits at 1200 baud. */
export const txDelayFlags = (ms: number) => Math.max(1, Math.ceil((ms * 1200) / 8000));

const tail4k = (s: string) => (s.length > 4096 ? s.slice(-4096) : s);

export class SoundcardPort {
  private rx: Afsk1200Rx;
  private capture: AudioChild | null = null;
  private captureUp = false;
  private lastPcmAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private player: AudioChild | null = null;
  private ptt: PttWatchdog | null = null;
  private pttError: string | null = null;
  private queue: { frame: Uint8Array; at: number }[] = [];
  private draining: Promise<void> | null = null;
  private transmitting = false;
  private unkeyedAt = -Infinity;
  private sent: SentFrames;
  private airtime: { at: number; ms: number }[] = [];
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
    this.rx = this.newDemodulator();
    this.sent = deps.sent ?? new SentFrames(() => this.now());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get tag(): string {
    return `[soundcard:${this.cfg.name}]`;
  }

  private newDemodulator(): Afsk1200Rx {
    return new Afsk1200Rx(this.cfg.rate, (raw) => this.onRxFrame(raw));
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
    const stallMs = this.deps.stallMs ?? 5000;
    this.stallTimer = setInterval(() => this.checkStall(stallMs), Math.min(1000, stallMs));
    this.stallTimer.unref?.();
  }

  /**
   * Stop: refuse new frames, end a playback, wait (bounded) for a transmission in progress to unkey, then close
   * the PTT. The PTT stays registered for the exit release until its close resolved, and a close that fails
   * falls back to the driver's synchronous release.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.capture?.kill("SIGTERM");
    this.player?.kill("SIGKILL");
    if (this.draining) await withTimeout(this.draining, STOP_WAIT_MS, "the transmission").catch(() => {});
    const ptt = this.ptt;
    if (!ptt) return;
    try {
      await ptt.close();
      untrackPtt(ptt);
    } catch (e) {
      this.error(`${this.tag} PTT close: ${(e as Error).message}; releasing it directly`);
      try {
        ptt.releaseSync();
      } catch {
        releaseAllSync();
      }
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
    if (this.stopped) return "the port is stopping";
    if (this.faultReason) return `the port is faulted: ${this.faultReason}`;
    if (!this.ptt) return this.pttError ?? "no PTT driver is open";
    if (!this.captureUp) return "capture is down, so carrier detect cannot see a busy channel";
    if (!this.gate.master()) return "transmit is switched off on this box";
    return this.gate.refusal(this.gate.calls);
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
    this.lastPcmAt = this.now();
    this.captureUp = true;
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
    this.queue.push({ frame, at: this.now() });
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return true;
  }

  private logRefusal(reason: string): void {
    const now = this.now();
    const last = this.refusalLogged.get(reason);
    if (last !== undefined && now - last < REFUSAL_LOG_MS) return;
    this.refusalLogged.set(reason, now);
    this.log(`${this.tag} transmit refused: ${reason}`);
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.stopped) {
      const item = this.queue.shift()!;
      try {
        const pcm = modulateAfsk1200(item.frame, this.cfg.rate, {
          flags: txDelayFlags(this.cfg.txDelayMs),
          amplitude: 1,
        });
        const airMs = (pcm.length / this.cfg.rate) * 1000 + this.cfg.txTailMs;
        if (airMs >= this.cfg.pttMaxMs) {
          this.error(
            `${this.tag} a ${Math.round(airMs)} ms transmission exceeds the PTT watchdog (SOUNDCARD_PTT_MAX_MS ${this.cfg.pttMaxMs}); frame dropped`,
          );
          continue;
        }
        const wait = await this.waitToSend(item.at, airMs);
        if (wait) {
          this.error(`${this.tag} ${wait}; frame dropped`);
          continue;
        }
        // the gate is checked again at the moment of keying: a remote TX off or a fault while waiting wins
        const refused = this.txRefusal();
        if (refused) {
          this.logRefusal(refused);
          this.queue = [];
          break;
        }
        await this.transmit(item.frame, pcm, airMs);
      } catch (e) {
        this.error(`${this.tag} transmit failed: ${(e as Error).message}`);
      }
    }
  }

  /** The airtime spent in the last minute. */
  private recentAirtime(now: number): number {
    this.airtime = this.airtime.filter((a) => now - a.at < DUTY_WINDOW_MS);
    return this.airtime.reduce((s, a) => s + a.ms, 0);
  }

  /**
   * Wait until the frame may go: a clear channel won by p-persistence, within the duty-cycle budget. Returns
   * null when it may, else why it was given up (the frame waited too long).
   */
  private async waitToSend(queuedAt: number, airMs: number): Promise<string | null> {
    const random = this.deps.random ?? Math.random;
    const budget = (this.cfg.dutyPct / 100) * DUTY_WINDOW_MS;
    for (;;) {
      if (this.stopped) return "the port stopped";
      const now = this.now();
      if (now - queuedAt > TX_MAX_AGE_MS)
        return `the frame waited over ${TX_MAX_AGE_MS / 1000} s (busy channel or duty cycle)`;
      const withinDuty = this.recentAirtime(now) + airMs <= budget;
      if (withinDuty && !this.rx.dcd && Math.floor(random() * 256) <= this.cfg.persist) return null;
      await this.sleep(this.cfg.slotTimeMs);
    }
  }

  private async transmit(frame: Uint8Array, pcm: Float32Array, airMs: number): Promise<void> {
    const ptt = this.ptt!;
    this.transmitting = true;
    this.sent.remember(frame);
    const startedAt = this.now();
    try {
      await ptt.key();
      await this.play(floatToS16(pcm, this.cfg.txLevel), airMs + PLAY_SLACK_MS);
      if (!this.faultReason) await this.sleep(this.cfg.txTailMs);
    } finally {
      // the watchdog already released a tripped PTT; this unkey is then a second, harmless one
      await ptt.unkey().catch((e: Error) => this.error(`${this.tag} PTT unkey failed: ${e.message}`));
      this.airtime.push({ at: startedAt, ms: airMs });
      this.unkeyedAt = this.now();
      this.rx = this.newDemodulator(); // nothing of the port's own signal stays in the demodulator
      this.transmitting = false;
    }
  }

  /** Play S16 audio to the end: aplay exits once its buffer has drained. Killed when it overruns `limitMs`. */
  private play(audio: Buffer, limitMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const done = (e: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(limit);
        clearTimeout(hard);
        if (this.player === child) this.player = null;
        if (e) reject(e);
        else resolve();
      };
      const child = this.spawn("aplay", alsaArgs(this.cfg.playback, this.cfg.rate));
      this.player = child;
      const limit = setTimeout(() => child.kill("SIGKILL"), limitMs);
      // a child that never reports its exit still lets the transmission end
      const hard = setTimeout(() => done(new Error(`playback did not end within ${limitMs} ms`)), limitMs + 1000);
      child.stderr?.on("data", (b) => (stderr = tail4k(stderr + b.toString())));
      child.on("error", (e) => done(new Error(alsaHint("aplay", e, stderr))));
      child.stdin?.on("error", () => {
        /* aplay exited early; its exit reports why */
      });
      child.on("exit", (code, signal) => {
        if (code === 0) done(null);
        else if (signal) done(new Error(`playback stopped (${signal})`));
        else done(new Error(alsaHint("aplay", null, stderr)));
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
    let ended = false;
    this.lastPcmAt = this.now();
    child.stdout?.on("data", (b) => {
      if (!heard) {
        heard = true;
        this.backoff.reset();
        this.log(`${this.tag} capturing ${this.cfg.device} at ${this.cfg.rate} Hz`);
      }
      this.pushPcm(read(b));
    });
    child.stderr?.on("data", (b) => (stderr = tail4k(stderr + b.toString())));
    // a failed spawn reports `error` and may never report `exit`: either ends this capture, once
    const over = () => {
      if (ended) return;
      ended = true;
      if (this.capture === child) this.capture = null;
      this.captureUp = false;
      if (this.stopped) return;
      const wait = this.backoff.next();
      this.error(
        `${this.tag} capture ended: ${alsaHint("arecord", failure, stderr)}; restarting in ${Math.round(wait / 1000)} s (no transmit meanwhile)`,
      );
      setTimeout(() => this.startCapture(), wait).unref?.();
    };
    child.on("error", (e) => {
      failure = e;
      over();
    });
    child.on("exit", over);
  }

  /** A capture that runs but delivers no audio (a wedged device) is restarted. */
  private checkStall(stallMs: number): void {
    if (this.stopped || !this.capture) return;
    if (this.now() - this.lastPcmAt <= stallMs) return;
    this.captureUp = false;
    this.error(`${this.tag} capture delivered no audio for ${Math.round(stallMs / 1000)} s; restarting it`);
    this.lastPcmAt = this.now();
    this.capture.kill("SIGKILL");
  }

  private onRxFrame(raw: Uint8Array): void {
    // half duplex: what the card hears while, or shortly after, the port transmits is its own signal
    if (this.transmitting || this.now() - this.unkeyedAt < RX_GUARD_MS) return;
    if (this.sent.echoes(raw)) return;
    this.h.onRaw?.(raw);
    const f = decodeAx25(raw);
    if (!f) return;
    this.h.onFrame?.(f);
    this.h.onPacket(tncPacket(f, SOUNDCARD_PORT, this.deps.siteCall, Math.floor(Date.now() / 1000)));
  }
}
