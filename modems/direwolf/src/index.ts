// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Direwolf's modem as WebAssembly: a receiver (300 / 1200 / 9600 bd, AX.25, FX.25 and IL2P) and a transmitter
 * that turns one frame into audio. Runs in Node, Bun and browsers alike: the module bytes come from a URL
 * (fetch), from a `file:` URL (read with `node:fs`, loaded only when the URL is one) or from the caller.
 *
 * Each receiver and transmitter is its own WebAssembly instance, because Direwolf keeps a modem's state in
 * globals; the compiled module is shared. The SIMD build is used where the runtime validates a SIMD probe.
 */
import createModule, { type DirewolfModule } from "../wasm/direwolf.mjs";

/** Where the WebAssembly comes from: a compiled module, its bytes, or a URL to fetch them from. */
export type DirewolfWasm = WebAssembly.Module | ArrayBuffer | Uint8Array | URL | string;

export interface DirewolfLoadOptions {
  /** The module to run. Defaults to the build next to this package, the SIMD one when the runtime has SIMD. */
  wasm?: DirewolfWasm;
  /** Force the SIMD (true) or the plain (false) build when `wasm` is not given. Defaults to feature detection. */
  simd?: boolean;
}

export type DirewolfBaud = 300 | 1200 | 9600;
export type DirewolfFec = "none" | "fx25" | "il2p";

export interface DirewolfFrame {
  /** The AX.25 frame: addresses, control, PID and information, without the FCS. */
  bytes: Uint8Array;
  /** The framing it arrived in. */
  fec: DirewolfFec;
  /**
   * What it took to recover: for FX.25 and IL2P the Reed–Solomon symbols corrected, for plain AX.25 the
   * bit-fix level (always 0 unless `fixBits` is set).
   */
  corrected: number;
  /** The demodulator (subchannel) and slicer that decoded it, for diagnostics. */
  subchannel: number;
  slice: number;
}

export interface DirewolfRxOptions extends DirewolfLoadOptions {
  sampleRate: number;
  baud: DirewolfBaud;
  /** A Direwolf demodulator profile; defaults to the speed's own (E+ at 1200 bd, D at 300 bd). */
  profile?: string;
  /** Accept frames sent as FX.25 (default true). */
  fx25?: boolean;
  /** Accept frames sent as IL2P (default true). */
  il2p?: boolean;
  /** Direwolf's FIX_BITS: 0 (the default) passes only frames whose FCS checks. */
  fixBits?: number;
}

export interface DirewolfRx {
  /** Feed mono PCM (16-bit, or float in -1..1); returns the frames it completed. */
  push(samples: Int16Array | Float32Array): DirewolfFrame[];
  /** Data carrier detect: true while a slicer sees HDLC flags or a frame. */
  readonly dcd: boolean;
  /** Drop all receive state, as after keying up: a frame in progress is discarded. */
  reset(): void;
}

export type DirewolfTxMode = "ax25" | "fx25" | "il2p";

export interface DirewolfTxOptions extends DirewolfLoadOptions {
  sampleRate: number;
  baud: DirewolfBaud;
  mode: DirewolfTxMode;
  /** FX.25 Reed–Solomon check bytes (16, 32 or 64; default 16). A frame too long for it goes out as AX.25. */
  fx25CheckBytes?: 16 | 32 | 64;
  /** IL2P: the maximum FEC (true, the default) or the size-based choice. */
  il2pMaxFec?: boolean;
  /** Preamble before the frame (HDLC flags, or the IL2P preamble pattern), in milliseconds. */
  txdelayMs: number;
  /** The same pattern after the frame, in milliseconds. */
  txtailMs: number;
  /** Peak level in percent of full scale (default 50, Direwolf's own). */
  amplitude?: number;
}

export interface DirewolfTx {
  /** The audio for one frame (AX.25 bytes without the FCS), preamble and tail included. */
  modulate(frame: Uint8Array): Int16Array;
}

const FEC: readonly DirewolfFec[] = ["none", "fx25", "il2p"];
const TX_MODE: Record<DirewolfTxMode, number> = { ax25: 0, fx25: 1, il2p: 2 };
const BAUDS: readonly number[] = [300, 1200, 9600];
// AX25_MAX_PACKET_LEN: ten addresses, control, PID and 2048 bytes of information
const MAX_FRAME = 10 * 7 + 2 + 3 + 2048;

// A function using one v128 instruction (wasm-feature-detect's SIMD probe).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Whether this runtime runs WebAssembly 128-bit SIMD. */
export function direwolfHasSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

async function readUrl(url: URL): Promise<ArrayBuffer | Uint8Array> {
  if (url.protocol === "file:") {
    // A variable specifier keeps bundlers from pulling node:fs into a browser build; only file: URLs get here.
    const fsName = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(u: URL): Promise<Uint8Array> };
    return fs.readFile(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Direwolf WebAssembly: ${url.href} answered ${res.status}`);
  return res.arrayBuffer();
}

const compiled = new Map<string, Promise<WebAssembly.Module>>();

function compile(opts: DirewolfLoadOptions): Promise<WebAssembly.Module> {
  const wasm = opts.wasm;
  if (wasm instanceof WebAssembly.Module) return Promise.resolve(wasm);
  if (wasm instanceof ArrayBuffer || wasm instanceof Uint8Array) return WebAssembly.compile(wasm as BufferSource);
  const url =
    wasm === undefined
      ? new URL(`../wasm/${(opts.simd ?? direwolfHasSimd()) ? "direwolf-simd" : "direwolf"}.wasm`, import.meta.url)
      : new URL(wasm, typeof location === "undefined" ? import.meta.url : location.href);
  let p = compiled.get(url.href);
  if (!p) {
    p = readUrl(url).then((bytes) => WebAssembly.compile(bytes as BufferSource));
    // a failed load is not cached, so a later call retries it
    p.catch(() => compiled.delete(url.href));
    compiled.set(url.href, p);
  }
  return p;
}

async function instantiate(opts: DirewolfLoadOptions): Promise<DirewolfModule> {
  const module = await compile(opts);
  return createModule({
    instantiateWasm(imports, receive) {
      void WebAssembly.instantiate(module, imports).then(receive);
      return {};
    },
  });
}

function checkCommon(sampleRate: number, baud: number): void {
  if (!BAUDS.includes(baud)) throw new RangeError(`Direwolf: baud must be 300, 1200 or 9600, not ${baud}`);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new RangeError(`Direwolf: sample rate ${sampleRate} is outside 8000..192000 Hz`);
  if (baud === 9600 && sampleRate < 38400)
    throw new RangeError(`Direwolf: 9600 bd needs a sample rate of at least 38400 Hz, not ${sampleRate}`);
}

/** A receiver for one audio channel. */
export async function createDirewolfRx(opts: DirewolfRxOptions): Promise<DirewolfRx> {
  checkCommon(opts.sampleRate, opts.baud);
  const m = await instantiate(opts);
  const init = (): void => {
    const profile = m.stringToNewUTF8(opts.profile ?? "");
    m._dwrx_init(
      opts.sampleRate,
      opts.baud,
      profile,
      opts.fixBits ?? 0,
      opts.fx25 === false ? 0 : 1,
      opts.il2p === false ? 0 : 1,
    );
    m._free(profile);
  };
  init();
  const inPtr = m._dw_in_ptr();
  const inCap = m._dw_in_cap();

  const collect = (len: number, frames: DirewolfFrame[]): void => {
    const base = m._dwrx_out_ptr();
    const view = m.HEAPU8.subarray(base, base + len);
    for (let p = 0; p + 5 <= len;) {
      const n = view[p]! | (view[p + 1]! << 8);
      frames.push({
        bytes: view.slice(p + 5, p + 5 + n),
        fec: FEC[view[p + 2]!] ?? "none",
        corrected: view[p + 4]!,
        subchannel: view[p + 3]! >> 4,
        slice: view[p + 3]! & 15,
      });
      p += 5 + n;
    }
    m._dwrx_out_clear();
  };

  return {
    push(samples) {
      const frames: DirewolfFrame[] = [];
      for (let off = 0; off < samples.length; off += inCap) {
        const n = Math.min(inCap, samples.length - off);
        const heap = m.HEAP16.subarray(inPtr >> 1, (inPtr >> 1) + n);
        if (samples instanceof Int16Array) heap.set(samples.subarray(off, off + n));
        else
          for (let i = 0; i < n; i++) {
            const v = Math.round(samples[off + i]! * 32767);
            heap[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
          }
        const len = m._dwrx_push(inPtr, n);
        if (len > 0) collect(len, frames);
      }
      return frames;
    },
    get dcd() {
      return m._dwrx_dcd() !== 0;
    },
    reset: init,
  };
}

/** A transmitter: one frame in, its audio out. */
export async function createDirewolfTx(opts: DirewolfTxOptions): Promise<DirewolfTx> {
  checkCommon(opts.sampleRate, opts.baud);
  const checkBytes = opts.fx25CheckBytes ?? 16;
  if (![16, 32, 64].includes(checkBytes)) throw new RangeError(`Direwolf: FX.25 check bytes must be 16, 32 or 64`);
  if (!(opts.mode in TX_MODE)) throw new RangeError(`Direwolf: unknown transmit mode ${String(opts.mode)}`);
  const amplitude = opts.amplitude ?? 50;
  if (!(amplitude > 0 && amplitude <= 100)) throw new RangeError(`Direwolf: amplitude must be in 1..100 percent`);
  for (const [k, v] of [
    ["txdelayMs", opts.txdelayMs],
    ["txtailMs", opts.txtailMs],
  ] as const)
    if (!(Number.isFinite(v) && v >= 0 && v <= 10_000)) throw new RangeError(`Direwolf: ${k} must be 0..10000 ms`);
  const m = await instantiate(opts);
  m._dwtx_init(
    opts.sampleRate,
    opts.baud,
    TX_MODE[opts.mode],
    checkBytes,
    opts.il2pMaxFec === false ? 0 : 1,
    Math.round(amplitude),
  );
  const inPtr = m._dw_in_ptr();

  return {
    modulate(frame) {
      if (frame.length < 15 || frame.length > MAX_FRAME)
        throw new RangeError(`Direwolf: an AX.25 frame is 15..${MAX_FRAME} bytes, not ${frame.length}`);
      m.HEAPU8.set(frame, inPtr);
      const n = m._dwtx_modulate(inPtr, frame.length, Math.round(opts.txdelayMs), Math.round(opts.txtailMs));
      if (n < 0) throw new RangeError("Direwolf: not an AX.25 frame");
      const out = m._dwtx_out_ptr();
      return m.HEAP16.slice(out >> 1, (out >> 1) + n);
    },
  };
}
