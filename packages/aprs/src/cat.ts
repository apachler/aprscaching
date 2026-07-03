// SPDX-License-Identifier: MIT
/**
 * cat.ts — CAT (Computer-Aided Transceiver) command encoders for browser-direct rig control over
 * Web Serial. Three protocol families cover most popular radios:
 *   - "kenwood"   ASCII `FA…;` (Kenwood TS-*, and modern Yaesu FT-991/FTDX which speak Kenwood CAT)
 *   - "icom"      CI-V binary `FE FE <addr> E0 05 <freq BCD LE> FD`
 *   - "yaesu-bin" classic 5-byte binary CAT (FT-817/857/897): BCD freq (10 Hz units) + opcode
 * Pure: produces the bytes to write; the browser owns the serial transport. Set-frequency is RX-side
 * (it only tunes), so it is NOT H5-gated. APRS calling frequencies live here for one-click tune.
 */
export type CatRig = "kenwood" | "icom" | "yaesu-bin";

/** APRS calling frequencies (Hz) for one-click tune. */
export const APRS_FREQ = { eu: 144_800_000, na: 144_390_000 } as const;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Kenwood/modern-Yaesu: `FA` + 11-digit Hz + `;`. */
function kenwoodFreq(hz: number): Uint8Array {
  return enc(`FA${Math.round(hz).toString().padStart(11, "0")};`);
}

/** Icom CI-V frequency BCD: 5 bytes, little-endian, two decimal digits per byte (1 Hz resolution). */
function civFreqBcd(hz: number): Uint8Array {
  const d = Math.round(hz).toString().padStart(10, "0"); // MSB-first decimal string
  const b = new Uint8Array(5);
  for (let i = 0; i < 5; i++) {
    const lo = d.charCodeAt(9 - i * 2) - 48;
    const hi = d.charCodeAt(8 - i * 2) - 48;
    b[i] = (hi << 4) | lo;
  }
  return b;
}

/** Classic Yaesu binary CAT: 4 BCD bytes of frequency in 10 Hz units, then the set-frequency opcode. */
function yaesuBinFreq(hz: number): Uint8Array {
  const u = Math.round(hz / 10)
    .toString()
    .padStart(8, "0");
  const b = new Uint8Array(5);
  for (let i = 0; i < 4; i++) b[i] = ((u.charCodeAt(i * 2) - 48) << 4) | (u.charCodeAt(i * 2 + 1) - 48);
  b[4] = 0x01;
  return b;
}

/** Encode a set-VFO-frequency command for `rig` at `hz`. `icomAddr` is the CI-V radio address. */
export function catSetFrequency(rig: CatRig, hz: number, opts: { icomAddr?: number } = {}): Uint8Array {
  if (rig === "kenwood") return kenwoodFreq(hz);
  if (rig === "yaesu-bin") return yaesuBinFreq(hz);
  const addr = opts.icomAddr ?? 0x94; // 0x94 = IC-7300; rig-specific — surfaced in the UI
  return Uint8Array.from([0xfe, 0xfe, addr & 0xff, 0xe0, 0x05, ...civFreqBcd(hz), 0xfd]);
}

// --- modes (best-effort; frequency is the reliable core) ---
const KENWOOD_MODE: Record<string, number> = {
  LSB: 1,
  USB: 2,
  CW: 3,
  FM: 4,
  AM: 5,
  RTTY: 6,
  FSK: 6,
  DATA: 6,
  FT8: 6,
  FT4: 6,
  PSK: 6,
  SSB: 2,
};
const ICOM_MODE: Record<string, number> = {
  LSB: 0,
  USB: 1,
  AM: 2,
  CW: 3,
  RTTY: 4,
  FM: 5,
  DATA: 1,
  FT8: 1,
  FT4: 1,
  PSK: 1,
  SSB: 1,
};

/** Encode a set-mode command, or null if the mode/rig pair isn't mapped. `mode` is upper-cased. */
export function catSetMode(rig: CatRig, mode: string, opts: { icomAddr?: number } = {}): Uint8Array | null {
  const m = mode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (rig === "kenwood") {
    const c = KENWOOD_MODE[m];
    return c == null ? null : enc(`MD${c};`);
  }
  if (rig === "icom") {
    const c = ICOM_MODE[m];
    if (c == null) return null;
    const addr = opts.icomAddr ?? 0x94;
    return Uint8Array.from([0xfe, 0xfe, addr & 0xff, 0xe0, 0x06, c, 0xfd]);
  }
  return null; // classic Yaesu mode opcode varies per model — skip
}
