// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard port's modem. By default it is Direwolf's, compiled to WebAssembly (`@aprscaching/direwolf`):
 * 300 bd (1600/1800 Hz, HF), 1200 bd (Bell 202) or 9600 bd (G3RUH), receiving plain AX.25, FX.25 and IL2P alike
 * and transmitting in the framing the port names. `SOUNDCARD_DEMOD=builtin` runs the TypeScript AFSK modem of
 * `packages/aprs/src/afsk.ts` instead (300 and 1200 bd, plain AX.25 only): the fallback when the WebAssembly
 * modem misbehaves on a box.
 *
 * Both sit behind one interface: PCM in, frames out with the framing they arrived in, carrier detect for CSMA,
 * a reset after the port's own transmission, and one frame's audio for the transmitter. The PTT, the capture and
 * the playback stay with the port.
 */
import { AfskRx, BELL_202, HF_300, modulateAfsk, type AfskModem } from "@aprscaching/aprs";
import {
  createDirewolfRx,
  createDirewolfTx,
  direwolfHasSimd,
  type DirewolfFec,
  type DirewolfTx,
  type DirewolfWasm,
} from "@aprscaching/direwolf";
import { floatToS16 } from "./alsa.js";

/** The soundcard modems: Bell 202 at 1200 baud, 300 baud on HF, or G3RUH at 9600 baud. */
export type SoundcardModem = "1200" | "hf300" | "9600";
/** Which implementation runs the modem: Direwolf's WebAssembly build, or the built-in TypeScript one. */
export type SoundcardDemod = "direwolf" | "builtin";
/** The framing a port transmits in: plain AX.25, FX.25 or IL2P. */
export type SoundcardFec = "off" | "fx25" | "il2p";

/** What the modem needs of a port's settings. */
export interface ModemSettings {
  rate: number;
  modem?: SoundcardModem;
  demod?: SoundcardDemod;
  fec?: SoundcardFec;
  fx25CheckBytes?: 16 | 32 | 64;
  txDelayMs: number;
  txTailMs: number;
  /** Transmit audio level, 0–1 of full scale. */
  txLevel: number;
}

/** A frame the modem decoded: AX.25 bytes without the FCS, and the framing it arrived in. */
export interface HeardFrame {
  bytes: Uint8Array;
  fec: DirewolfFec;
  /** The Reed–Solomon symbols FX.25 or IL2P corrected; 0 for plain AX.25. */
  corrected: number;
}

export interface PortModem {
  readonly kind: SoundcardDemod;
  /** Feed captured PCM; returns the frames it completed. */
  push(pcm: Float32Array): HeardFrame[];
  /** Carrier detect: the channel is busy. */
  readonly dcd: boolean;
  /** Drop all receive state, as after the port's own transmission. */
  reset(): void;
  /**
   * One frame's audio as S16_LE, its TXDELAY preamble included, and how long the PTT stays keyed in silence after
   * it: Direwolf sends TXTAIL as flags inside the audio, the built-in modem holds the key for it.
   */
  modulate(frame: Uint8Array): Promise<{ audio: Buffer; tailMs: number }>;
}

/** The line rate of a port's modem. */
const modemBaud = (m: SoundcardModem | undefined): 300 | 1200 | 9600 =>
  m === "hf300" ? 300 : m === "9600" ? 9600 : 1200;

/** The built-in AFSK modem a port's setting names (it has no 9600 baud). */
const afskModem = (m: SoundcardModem | undefined): AfskModem => (m === "hf300" ? HF_300 : BELL_202);

/** HDLC flags for a TXDELAY: one flag is 8 bits at the modem's baud rate (1200 unless named). */
export const txDelayFlags = (ms: number, baud = 1200) => Math.max(1, Math.ceil((ms * baud) / 8000));

/** Why the built-in modem cannot serve these settings, or null when it can. */
export function builtinProblem(s: Pick<ModemSettings, "modem" | "fec">): string | null {
  if (s.modem === "9600") return "9600 baud needs the Direwolf modem";
  if (s.fec && s.fec !== "off") return "FX.25 and IL2P need the Direwolf modem";
  return null;
}

/** The built-in TypeScript AFSK modem: 300 or 1200 baud, plain AX.25. */
function builtinModem(s: ModemSettings): PortModem {
  const modem = afskModem(s.modem);
  let heard: HeardFrame[] = [];
  const make = () => new AfskRx(s.rate, (bytes) => heard.push({ bytes, fec: "none", corrected: 0 }), modem);
  let rx = make();
  return {
    kind: "builtin",
    push(pcm) {
      heard = [];
      rx.push(pcm);
      return heard;
    },
    get dcd() {
      return rx.dcd;
    },
    reset() {
      rx = make();
    },
    modulate(frame) {
      const pcm = modulateAfsk(frame, s.rate, {
        flags: txDelayFlags(s.txDelayMs, modem.baud),
        modem,
        amplitude: 1,
      });
      return Promise.resolve({ audio: floatToS16(pcm, s.txLevel), tailMs: s.txTailMs });
    },
  };
}

const TX_MODE = { off: "ax25", fx25: "fx25", il2p: "il2p" } as const;

/** Direwolf's modem in WebAssembly; rejects when the module does not load. */
export async function direwolfModem(s: ModemSettings, wasm?: DirewolfWasm): Promise<PortModem> {
  const baud = modemBaud(s.modem);
  const rx = await createDirewolfRx({ sampleRate: s.rate, baud, ...(wasm ? { wasm } : {}) });
  // the transmitter is its own instance, made on the first frame: a receive-only port never needs it
  let tx: Promise<DirewolfTx> | null = null;
  return {
    kind: "direwolf",
    push: (pcm) =>
      rx.push(pcm).map((f) => ({ bytes: f.bytes, fec: f.fec, corrected: f.fec === "none" ? 0 : f.corrected })),
    get dcd() {
      return rx.dcd;
    },
    reset: () => rx.reset(),
    async modulate(frame) {
      if (!tx) {
        tx = createDirewolfTx({
          sampleRate: s.rate,
          baud,
          mode: TX_MODE[s.fec ?? "off"],
          fx25CheckBytes: s.fx25CheckBytes ?? 16,
          txdelayMs: s.txDelayMs,
          txtailMs: s.txTailMs,
          amplitude: Math.min(100, Math.max(1, Math.round(s.txLevel * 100))),
          ...(wasm ? { wasm } : {}),
        });
        // a transmitter that failed to load is made again for the next frame
        tx.catch(() => (tx = null));
      }
      const audio = (await tx).modulate(frame);
      return { audio: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), tailMs: 0 };
    },
  };
}

/**
 * The modem a port's settings name. When Direwolf's module does not load and the built-in modem can serve the
 * port, it runs that instead and `onFallback` hears why; otherwise the load error is thrown.
 */
export async function openModem(
  s: ModemSettings,
  o: { wasm?: DirewolfWasm; onFallback?: (why: string) => void } = {},
): Promise<PortModem> {
  if (s.demod === "builtin") return builtinModem(s);
  try {
    return await direwolfModem(s, o.wasm);
  } catch (e) {
    const why = `the Direwolf modem did not load: ${(e as Error).message}`;
    if (builtinProblem({ modem: s.modem }) !== null) throw new Error(why, { cause: e });
    const plain = s.fec && s.fec !== "off" ? "; it transmits plain AX.25" : "";
    o.onFallback?.(`${why}; the built-in modem runs instead${plain}`);
    return builtinModem(s);
  }
}

/** A port's modem in words, for the logs and the doctor. */
export function describeModem(s: ModemSettings): string {
  const speed = s.modem === "hf300" ? "300 baud HF" : s.modem === "9600" ? "9600 baud G3RUH" : "1200 baud Bell 202";
  if (s.demod === "builtin") return `the built-in modem, ${speed}, AX.25`;
  const framing =
    s.fec === "fx25" ? `FX.25 (${s.fx25CheckBytes ?? 16} check bytes)` : s.fec === "il2p" ? "IL2P" : "AX.25";
  return `Direwolf ${speed}${direwolfHasSimd() ? " (SIMD)" : ""}, transmits ${framing}, receives AX.25, FX.25 and IL2P`;
}
