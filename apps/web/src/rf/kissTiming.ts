// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * kissTiming.ts — the channel-access parameters My radio sends a KISS TNC as the link comes up (TXDELAY,
 * PERSIST, SLOTTIME), so the browser's settings decide when the radio keys up, not whatever the TNC was last
 * left on. The values, their checks and their stored form; the frames themselves come from @aprscaching/aprs.
 */
import { KISS_TIMING_DEFAULTS, type KissTiming } from "@aprscaching/aprs";

export { KISS_TIMING_DEFAULTS, type KissTiming };

export type KissTimingKey = keyof KissTiming;

/** One setting: its label, the one-line hint the control carries, and the unit one step stands for. */
export interface KissTimingField {
  key: KissTimingKey;
  label: string;
  hint: string;
  /** Milliseconds per step, or null when the value is a plain number. */
  msPerStep: number | null;
}

export const KISS_TIMING_FIELDS: readonly KissTimingField[] = [
  {
    key: "txDelay",
    label: "TX delay",
    hint: "How long the radio keys up before the data starts, in 10 ms steps. 30 (300 ms) suits most radios.",
    msPerStep: 10,
  },
  {
    key: "persist",
    label: "Persist",
    hint: "The chance the TNC sends in a free slot: (value + 1) in 256. 63 is one in four.",
    msPerStep: null,
  },
  {
    key: "slotTime",
    label: "Slot time",
    hint: "How long the TNC waits between tries for a free channel, in 10 ms steps. 10 (100 ms) is usual.",
    msPerStep: 10,
  },
];

/** A setting's value from what was typed: a whole number 0–255, or null when it is not one. */
export function parseKissValue(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 255 ? n : null;
}

/** A value's reading for the person: "300 ms" for a time, "1 in 4" (or a percentage) for persist. */
export function kissValueText(key: KissTimingKey, v: number): string {
  if (key === "persist") {
    if (v === 255) return "every free slot";
    const odds = 256 / (v + 1);
    return Number.isInteger(odds) ? `1 in ${odds}` : `${(((v + 1) / 256) * 100).toFixed(0)}%`;
  }
  return `${v * 10} ms`;
}

/** The stored settings, each value kept only when it is a whole number 0–255; anything else takes its default. */
export function readKissTiming(raw: string | null): KissTiming {
  let o: Partial<Record<KissTimingKey, unknown>> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") o = parsed as typeof o;
  } catch {
    /* unreadable: the defaults */
  }
  const pick = (k: KissTimingKey) => {
    const v = o[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255 ? v : KISS_TIMING_DEFAULTS[k];
  };
  return { txDelay: pick("txDelay"), persist: pick("persist"), slotTime: pick("slotTime") };
}

/** Do these settings match the defaults? */
export const isDefaultKissTiming = (t: KissTiming): boolean =>
  t.txDelay === KISS_TIMING_DEFAULTS.txDelay &&
  t.persist === KISS_TIMING_DEFAULTS.persist &&
  t.slotTime === KISS_TIMING_DEFAULTS.slotTime;
