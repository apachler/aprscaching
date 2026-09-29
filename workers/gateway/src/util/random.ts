// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Uniform integers and strings from the CSPRNG. `random % n` over-weights the low residues whenever n
 * does not divide 2^32, so a draw that lands in the incomplete top block is discarded and redrawn
 * (rejection sampling); the expected number of draws stays below two for every n.
 */
const RANGE = 2 ** 32;

/** A uniform integer in [0, n), for 1 ≤ n ≤ 2^32. */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > RANGE) throw new RangeError(`randomInt bound out of range: ${n}`);
  const limit = RANGE - (RANGE % n); // the largest multiple of n that fits; draws at or above it are biased
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    if (word[0]! < limit) return word[0]! % n;
  }
}

/** `length` characters drawn uniformly from `alphabet`. */
export function randomString(alphabet: string, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[randomInt(alphabet.length)]!;
  return s;
}
