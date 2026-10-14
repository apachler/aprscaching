// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Duplicate packets. One transmission reaches the gateway several times: heard directly and again via a
 * digipeater, through a box's radio port and again on the APRS-IS feed, or from two receivers. APRS-IS
 * treats a packet as a duplicate when its source (with SSID), its destination (without SSID) and its
 * information field match one seen within 30 seconds; the path is left out, since every digipeater
 * changes it. The gateway applies the same rule to what it logs: the raw-packet ring and the message log
 * keep one copy, and a copy heard on RF replaces an earlier one that came over APRS-IS, so the record shows
 * the strongest provenance. Every copy still reaches everything else (positions, acks, radio commands,
 * the verify engine), so de-duplication never costs a find its tier.
 */
import type { Env } from "./env.js";

/** The window in which a repeated packet counts as the same transmission. */
export const DUPE_WINDOW_SEC = 30;

interface Copy {
  src: string;
  dst?: string | null;
  payload: string;
  ts: number;
  heardVia?: string | null;
}

/** A logged copy of a packet: its packets_recent row. */
export interface StoredCopy {
  id: number;
  callsign: string;
  ts: number;
  dst: string | null;
  payload: string;
  heard_via: string | null;
}

/** What to do with one incoming packet in the logs. */
export type Fate = { kind: "store" } | { kind: "skip" } | { kind: "upgrade"; stored: StoredCopy };

/** The APRS-IS duplicate key: source with SSID, destination without, information field. */
export function dupeKey(c: { src: string; dst?: string | null; payload: string }): string {
  const dst = (c.dst ?? "").trim().toUpperCase().split("-")[0];
  return `${c.src.trim().toUpperCase()}>${dst}:${c.payload}`;
}

const isRf = (heardVia: string | null | undefined) => heardVia === "rf";

/**
 * The packets_recent rows that could be earlier copies of this batch: the batch's sources, within the
 * window around its timestamps. Queried in chunks to stay under the statement's parameter limit.
 */
export async function recentCopies(env: Env, batch: Copy[]): Promise<StoredCopy[]> {
  if (!batch.length) return [];
  const calls = [...new Set(batch.map((c) => c.src))];
  const from = Math.min(...batch.map((c) => c.ts)) - DUPE_WINDOW_SEC;
  const to = Math.max(...batch.map((c) => c.ts)) + DUPE_WINDOW_SEC;
  const rows: StoredCopy[] = [];
  for (let i = 0; i < calls.length; i += 200) {
    const chunk = calls.slice(i, i + 200);
    const res = await env.DB.prepare(
      `SELECT id, callsign, ts, dst, payload, heard_via FROM packets_recent
        WHERE ts BETWEEN ? AND ? AND callsign IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(from, to, ...chunk)
      .all<StoredCopy>();
    rows.push(...(res.results ?? []));
  }
  return rows;
}

/**
 * Decide, in order, each packet's fate in the logs. A packet with no copy within the window is stored. A
 * later copy is skipped, unless it was heard on RF and the copy kept so far was not: then it takes that
 * copy's place, either in this batch (it is stored instead) or in the log (the stored row is upgraded).
 */
export function planDupes(batch: Copy[], stored: StoredCopy[]): Fate[] {
  const fates: Fate[] = batch.map(() => ({ kind: "store" }));
  // per key, the copies kept so far: rows already logged and packets of this batch
  const kept = new Map<string, ({ row: StoredCopy } | { index: number })[]>();
  for (const row of stored) {
    const key = dupeKey({ src: row.callsign, dst: row.dst, payload: row.payload });
    kept.set(key, [...(kept.get(key) ?? []), { row }]);
  }
  batch.forEach((c, i) => {
    const key = dupeKey(c);
    const prior = (kept.get(key) ?? []).find(
      (k) => Math.abs(("row" in k ? k.row.ts : batch[k.index]!.ts) - c.ts) <= DUPE_WINDOW_SEC,
    );
    if (!prior) {
      kept.set(key, [...(kept.get(key) ?? []), { index: i }]);
      return;
    }
    if ("row" in prior) {
      fates[i] =
        isRf(c.heardVia) && !isRf(prior.row.heard_via) ? { kind: "upgrade", stored: prior.row } : { kind: "skip" };
      // an upgraded row now stands for an RF copy: a further RF copy is a plain duplicate
      if (fates[i]!.kind === "upgrade") prior.row = { ...prior.row, heard_via: "rf" };
      return;
    }
    if (isRf(c.heardVia) && !isRf(batch[prior.index]!.heardVia)) {
      fates[prior.index] = { kind: "skip" };
      prior.index = i; // this copy is stored in its place
      return;
    }
    fates[i] = { kind: "skip" };
  });
  return fates;
}
