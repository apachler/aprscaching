// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The logbook's note on a log that reached the instance late. A log's time is when it was made (its
 * signed field time); a log queued offline arrives later, and the note says both. When the instance did
 * not take the signed time, the note says the log counts from its arrival, and why.
 */
import type { CacheLogEntry } from "@aprscaching/shared";

/** Arrivals within this of the find time read as live. */
const LATE_S = 5 * 60;

const REASON: Record<string, string> = {
  unsigned: "unsigned",
  future: "its clock was ahead",
  too_old: "made more than 7 days before it arrived",
  before_cache: "dated before the cache existed",
  before_key: "dated before its key was registered",
};

export function syncNote(l: CacheLogEntry, dateTime: (ts: number) => string): string | null {
  if (l.fieldTimeRejected) {
    const why = REASON[l.fieldTimeRejected] ?? l.fieldTimeRejected;
    return l.fieldTimeRejected === "unsigned"
      ? `logged offline, unsigned · counts from ${dateTime(l.ts)}`
      : `counts from its arrival: ${why}`;
  }
  if (l.receivedAt != null && l.receivedAt - l.ts > LATE_S)
    return `logged offline at ${dateTime(l.ts)}, synced ${dateTime(l.receivedAt)}`;
  return null;
}
