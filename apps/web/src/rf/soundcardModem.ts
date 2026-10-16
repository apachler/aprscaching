// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard link's modem protocol, shared by the page (`soundcard.ts`) and the modem worker
 * (`soundcard.worker.ts`). Pure: no browser globals, so it is unit-tested as is.
 *
 * The audio never crosses the main thread. An AudioWorklet taps the microphone and posts blocks of samples
 * straight to a dedicated Worker over a MessageChannel; the Worker runs the demodulator and posts back only the
 * frames it completed. The demodulator is Direwolf's, compiled to WebAssembly (`@aprscaching/direwolf`):
 * 300 or 1200 baud, receiving plain AX.25, FX.25 and IL2P alike. It runs in a Worker rather than in the worklet
 * because the audio render thread has no `fetch` for the module, must finish each 128-sample quantum in a few
 * milliseconds, and would run the Emscripten loader's globals once per AudioContext; a Worker has none of
 * those limits and keeps MapLibre and the UI on the main thread smooth.
 *
 * When the WebAssembly does not load (blocked, or not cached while offline), the Worker reports a load failure
 * and the link does not connect: its error names the cause and what to do about it.
 */

/** The soundcard links' speeds: 1200 baud Bell 202 (VHF) or 300 baud on HF. */
export type AudioBaud = 300 | 1200;
/** The framing a frame arrived in. */
export type AudioFec = "none" | "fx25" | "il2p";

/** The page asks the Worker to start: its sample rate and speed, and the port the samples arrive on. */
export interface ModemStart {
  type: "start";
  sampleRate: number;
  baud: AudioBaud;
  samples: MessagePort;
}

/** One decoded frame: AX.25 bytes without the FCS, the framing it arrived in and the symbols its FEC corrected. */
export interface HeardAudioFrame {
  bytes: Uint8Array;
  fec: AudioFec;
  corrected: number;
}

/**
 * What the Worker tells the page: the modem runs (as the SIMD build or not), the frames it heard, or why it did
 * not start; `load` marks a failure to load Direwolf's WebAssembly.
 */
export type ModemReply =
  | { type: "ready"; simd: boolean }
  | { type: "frames"; frames: HeardAudioFrame[] }
  | { type: "failed"; message: string; load: boolean };

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;

export function isModemStart(m: unknown): m is ModemStart {
  return (
    isObj(m) &&
    m.type === "start" &&
    typeof m.sampleRate === "number" &&
    Number.isInteger(m.sampleRate) &&
    m.sampleRate >= 8000 &&
    m.sampleRate <= 192000 &&
    (m.baud === 300 || m.baud === 1200) &&
    isObj(m.samples) &&
    typeof m.samples.postMessage === "function"
  );
}

export function isModemReply(m: unknown): m is ModemReply {
  if (!isObj(m)) return false;
  if (m.type === "ready") return typeof m.simd === "boolean";
  if (m.type === "frames")
    return Array.isArray(m.frames) && m.frames.every((f) => isObj(f) && f.bytes instanceof Uint8Array);
  return m.type === "failed" && typeof m.message === "string" && typeof m.load === "boolean";
}

/** The modem in a few words, for the link's status line. */
export function modemNote(r: { simd: boolean }): string {
  return r.simd ? "Direwolf modem (SIMD)" : "Direwolf modem";
}

/**
 * Why the soundcard link did not connect, in the user's words. A modem that did not load names its two usual
 * causes: a browser offline that never kept the modem, or one that blocks WebAssembly.
 */
export function modemFailure(r: { message: string; load: boolean }): string {
  if (!r.load) return `the soundcard modem did not start: ${r.message}`;
  return (
    `the soundcard modem could not load (${r.message}). Connect the soundcard once while online, so the browser ` +
    "keeps the modem for offline use, or allow WebAssembly for this site if the browser or an extension blocks it"
  );
}

/** Samples per block the worklet posts to the modem: about 43 ms at 48 kHz, so 23 messages a second. */
export const TAP_BLOCK = 2048;

/**
 * The AudioWorklet processor: it buffers the input into blocks of TAP_BLOCK samples and posts each to the port
 * the page hands it (the modem Worker's), transferring the buffer. Until that port arrives it drops the audio.
 * A string, loaded as a Blob URL, so the worklet needs no bundler wiring.
 */
export const TAP_WORKLET = `
class AcsModemTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.buf = new Float32Array(${TAP_BLOCK});
    this.n = 0;
    this.port.onmessage = (e) => { this.out = e.data; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.out) return true;
    for (let i = 0; i < ch.length; ) {
      const k = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + k), this.n);
      this.n += k;
      i += k;
      if (this.n === this.buf.length) {
        this.out.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(${TAP_BLOCK});
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("acs-modem-tap", AcsModemTap);
`;
