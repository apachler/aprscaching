// SPDX-License-Identifier: MIT
/**
 * deviceid.ts — name the device or software that sent a packet, from a device table in the shape of the APRS
 * device identification database (aprs-deviceid, `tocalls.dense.json`). This module is only the matcher: it
 * ships no table. The caller loads one (the database itself is CC BY-SA 2.0, kept apart from this MIT code) and
 * passes it to {@link buildDeviceIndex}.
 *
 * A packet names its device in one of two ways:
 * - the **tocall**, the AX.25 destination of an ordinary packet (`APDW17` is Dire Wolf). A table key may hold
 *   wildcards: `?` stands for any one character, `n` for one digit, and a trailing `*` for any rest. The most
 *   specific key wins: an exact key first, then the one with the most literal characters.
 * - the **Mic-E device code** around a Mic-E status text, since a Mic-E destination carries the latitude, not a
 *   tocall. A `` ` `` or `'` prefix pairs with a two-character suffix (`mice`); a Kenwood `>` or `]` prefix with
 *   an optional one-character suffix (`micelegacy`, keyed by prefix then suffix).
 */
import type { MicEDeviceCode } from "./types.js";

/** One device entry as the table holds it. */
export interface DeviceEntry {
  vendor?: string;
  model?: string;
  class?: string;
  os?: string;
  features?: string[];
}

/** The table as fetched: the sections the matcher reads. Anything else in it is ignored. */
export interface DeviceTable {
  tocalls?: Record<string, DeviceEntry>;
  mice?: Record<string, DeviceEntry>;
  micelegacy?: Record<string, DeviceEntry>;
  classes?: Record<string, { shown?: string; description?: string }>;
}

/** A named device: its model (or the vendor when the entry names no model), vendor and class label. */
export interface DeviceMatch {
  name: string;
  vendor?: string;
  /** The class's shown label (`HT`, `Rig`, `Desktop software`), else the raw class id. */
  class?: string;
}

interface Pattern {
  key: string;
  entry: DeviceMatch;
  /** the literal characters, the more the more specific */
  literals: number;
  /** a `*` takes any rest */
  open: boolean;
}

/** A table prepared for lookups. */
export interface DeviceIndex {
  exact: Map<string, DeviceMatch>;
  patterns: Pattern[];
  mice: Map<string, DeviceMatch>;
  micelegacy: Map<string, DeviceMatch>;
}

/** Bounds on a table from the network, far above the real database's size. */
const MAX_ENTRIES = 20_000;
const MAX_KEY = 9;
const MAX_TEXT = 120;

/** A bounded text value; `Unknown` (the generic `APRS` tocall's model) names nothing, so it reads as absent. */
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "unknown" ? v.trim().slice(0, MAX_TEXT) : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toMatch(raw: unknown, classes: Map<string, string>): DeviceMatch | null {
  if (!isRecord(raw)) return null;
  const vendor = text(raw.vendor);
  const name = text(raw.model) ?? vendor;
  if (!name) return null;
  const cls = text(raw.class);
  return {
    name,
    ...(vendor && vendor !== name ? { vendor } : {}),
    ...(cls ? { class: classes.get(cls) ?? cls } : {}),
  };
}

function section(raw: unknown, classes: Map<string, string>): [string, DeviceMatch][] {
  if (!isRecord(raw)) return [];
  const out: [string, DeviceMatch][] = [];
  for (const [key, v] of Object.entries(raw)) {
    if (out.length >= MAX_ENTRIES) break;
    if (!key || key.length > MAX_KEY) continue;
    const m = toMatch(v, classes);
    if (m) out.push([key, m]);
  }
  return out;
}

/** A tocall key with wildcards: `?`, `n` (lowercase) or `*`. */
const isPattern = (key: string) => /[?n*]/.test(key);

/**
 * Prepare a table for lookups; null when it is not a device table at all (no tocall and no Mic-E section). An
 * entry that names neither a model nor a vendor is skipped, and every string is bounded.
 */
export function buildDeviceIndex(table: unknown): DeviceIndex | null {
  if (!isRecord(table)) return null;
  const classes = new Map<string, string>();
  if (isRecord(table.classes))
    for (const [id, c] of Object.entries(table.classes)) {
      const shown = isRecord(c) ? text(c.shown) : undefined;
      if (shown) classes.set(id, shown);
    }
  const exact = new Map<string, DeviceMatch>();
  const patterns: Pattern[] = [];
  for (const [key, entry] of section(table.tocalls, classes)) {
    if (!isPattern(key)) {
      exact.set(key.toUpperCase(), entry);
      continue;
    }
    const star = key.indexOf("*");
    // a `*` takes the rest, so anything after one is never read
    const body = star >= 0 ? key.slice(0, star) : key;
    patterns.push({ key: body, entry, literals: body.replace(/[?n]/g, "").length, open: star >= 0 });
  }
  // most specific first: more literal characters, then a fixed length before an open one, then more digits
  patterns.sort(
    (a, b) =>
      b.literals - a.literals ||
      Number(a.open) - Number(b.open) ||
      countDigits(b.key) - countDigits(a.key) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const mice = new Map(section(table.mice, classes));
  const micelegacy = new Map(section(table.micelegacy, classes));
  if (!exact.size && !patterns.length && !mice.size && !micelegacy.size) return null;
  return { exact, patterns, mice, micelegacy };
}

const countDigits = (key: string) => key.split("n").length - 1;

function matches(p: Pattern, call: string): boolean {
  if (p.open ? call.length < p.key.length : call.length !== p.key.length) return false;
  for (let i = 0; i < p.key.length; i++) {
    const k = p.key[i]!;
    const c = call[i]!;
    if (k === "?") continue;
    if (k === "n") {
      if (c < "0" || c > "9") return false;
    } else if (k.toUpperCase() !== c) return false;
  }
  return true;
}

/** The device behind a tocall (an AX.25 destination, with or without SSID); null when the table has none. */
export function deviceByTocall(index: DeviceIndex, dst: string): DeviceMatch | null {
  const call = (dst.split("-")[0] ?? "").trim().toUpperCase();
  if (!call || call.length > 6) return null;
  const hit = index.exact.get(call);
  if (hit) return hit;
  for (const p of index.patterns) if (matches(p, call)) return p.entry;
  return null;
}

/** The device behind a Mic-E device code; null when the code names none the table knows. */
export function deviceByMicE(index: DeviceIndex, code: MicEDeviceCode): DeviceMatch | null {
  const { prefix, suffix } = code;
  if (prefix === "`" || prefix === "'") return suffix.length === 2 ? (index.mice.get(suffix) ?? null) : null;
  if (prefix === ">" || prefix === "]") {
    const tail = suffix.slice(-1);
    return (tail ? index.micelegacy.get(prefix + tail) : undefined) ?? index.micelegacy.get(prefix) ?? null;
  }
  return null;
}

/**
 * The device behind a packet. A Mic-E packet is named by its device code alone, its destination being position
 * data; any other packet by its tocall.
 */
export function identifyDevice(
  index: DeviceIndex,
  packet: { dst?: string | null; micE?: MicEDeviceCode | null; isMicE?: boolean },
): DeviceMatch | null {
  if (packet.micE) return deviceByMicE(index, packet.micE);
  if (packet.isMicE) return null;
  return packet.dst ? deviceByTocall(index, packet.dst) : null;
}
