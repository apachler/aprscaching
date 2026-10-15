// SPDX-License-Identifier: MIT
/**
 * hf.ts — the HF APRS preset: 30 m at 300 baud. HF has no digipeaters, so a frame goes out with an empty path
 * (two path entries are 14 bytes, 0.37 s at 300 baud). A beacon is Mic-E and comes every 10–15
 * minutes, with its comment on every fourth only.
 *
 * The radio sits on 10.1476 MHz upper sideband, the dial frequency. The modem's 1600/1800 Hz tones land 1.6 and
 * 1.8 kHz above it, on 10.1492 and 10.1494 MHz; set the dial, never the tone frequency.
 */
import { HF_300 } from "./afsk.js";
import { encodeMicE, type MicEEncodeOpts } from "./mice.js";

export const HF_APRS = {
  /** The 30 m APRS dial frequency, worldwide. */
  dialMhz: 10.1476,
  /** The sideband the dial frequency is given for. */
  mode: "USB",
  modem: HF_300,
  /** No digipeaters on HF: the path stays empty. */
  path: [] as readonly string[],
  /** The shortest and the longest beacon interval, seconds. */
  beaconMinSec: 600,
  beaconMaxSec: 900,
  /** The beacon carries its comment once in this many. */
  commentEvery: 4,
} as const;

/**
 * The `n`th HF beacon (counting from 0): a Mic-E position whose comment rides on beacons 0, 4, 8 …, so three in
 * four are the nine bytes of the position alone.
 */
export function hfBeacon(
  n: number,
  lat: number,
  lon: number,
  opts: MicEEncodeOpts = {},
): { dest: string; info: string } {
  const { comment, ...rest } = opts;
  return encodeMicE(lat, lon, n % HF_APRS.commentEvery === 0 ? { ...rest, comment } : rest);
}
