// SPDX-License-Identifier: MIT
/**
 * DXCC entities, the countries of amateur radio: a cache's country is the primary prefix of its entity (`OE`,
 * `DL`, `9A`), the way hams name countries. The data is AD1C's country file (`dxcc-data.ts`, MIT).
 */
import { z } from "zod";
import { DXCC_ROWS, CTY_VERSION } from "./dxcc-data.js";

export { CTY_VERSION };

export interface DxccEntity {
  /** The primary prefix, the entity's name on the air: `OE`, `DL`, `KH6`. */
  prefix: string;
  name: string;
  continent: string;
  cq: number;
  itu: number;
}

const BY_PRIMARY = new Map<string, DxccEntity>();
const BY_PREFIX = new Map<string, DxccEntity>();
for (const [prefix, name, continent, cq, itu, others] of DXCC_ROWS) {
  const e: DxccEntity = { prefix, name, continent, cq, itu };
  // keyed upper-case: a few primaries carry a lowercase marker (`3D2/c`, Conway Reef, beside `3D2`, Fiji)
  BY_PRIMARY.set(prefix.toUpperCase(), e);
  BY_PREFIX.set(prefix.toUpperCase(), e);
  for (const p of others ? others.split(",") : []) if (!BY_PREFIX.has(p)) BY_PREFIX.set(p, e);
}
const LONGEST = Math.max(...[...BY_PREFIX.keys()].map((p) => p.length));

/** Every DXCC entity, by name. */
export const DXCC_ENTITIES: readonly DxccEntity[] = [...BY_PRIMARY.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** The entity a primary prefix names, any case; undefined for anything else. */
export const dxccEntity = (prefix: string): DxccEntity | undefined => BY_PRIMARY.get(prefix.trim().toUpperCase());

/** The entity whose prefix starts `s` the longest way. */
function longestPrefix(s: string): DxccEntity | undefined {
  for (let n = Math.min(LONGEST, s.length); n > 0; n--) {
    const e = BY_PREFIX.get(s.slice(0, n));
    if (e) return e;
  }
  return undefined;
}

/** Operating suffixes after a `/`, which say how a station operates rather than where. */
const SUFFIX = /^(P|M|MM|AM|QRP|QRPP|A|B|LH|R|T|\d)$/;

/**
 * The DXCC entity a callsign operates from, by its longest matching prefix: `OE8APR` and `OE8APR-7` → Austria,
 * `DL/OE8APR` → Germany (a prefix before or after the `/` names the country operated from). Undefined when no
 * prefix matches. A callsign the country file lists one by one (some special-event calls) resolves by its
 * prefix alone.
 */
export function dxccOfCall(call: string): DxccEntity | undefined {
  const parts = call
    .trim()
    .toUpperCase()
    .split("-")[0]!
    .split("/")
    .filter((p) => p && !SUFFIX.test(p));
  if (!parts.length) return undefined;
  if (parts.length === 1) return longestPrefix(parts[0]!);
  // the shorter part of `DL/OE8APR` or `OE8APR/DL` is the country prefix
  const [a, b] = parts[0]!.length <= parts[1]!.length ? [parts[0]!, parts[1]!] : [parts[1]!, parts[0]!];
  return longestPrefix(a) ?? longestPrefix(b);
}

/** A cache's country: the primary prefix of a DXCC entity, any case, stored as the country file spells it. */
export const DxccPrefix = z
  .string()
  .trim()
  .refine((s) => BY_PRIMARY.has(s.toUpperCase()), { message: "country must be a DXCC prefix, such as OE" })
  .transform((s) => BY_PRIMARY.get(s.toUpperCase())!.prefix);
