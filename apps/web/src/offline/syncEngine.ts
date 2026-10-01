// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One sync for the app's offline state: first the log queue (log/logQueue.ts), then the offline packs that
 * have aged. It runs on app start, when the connection returns, when a backed-off log comes due, and on
 * Sync now; with the app closed, the service worker's Background Sync sends the queue (Chromium; Safari
 * and Firefox have no Background Sync, so there the queue goes when the app is next opened).
 *
 * Packs are refreshed automatically only on an unmetered connection (Wi-Fi, Ethernet), unless the user
 * allows mobile data; Sync now refreshes them whatever the connection. A pack whose refresh failed waits,
 * backing off, before the next automatic try.
 */
import type { PackMeta } from "./store.js";

/** A pack older than this is refreshed by an automatic sync. */
export const AUTO_REFRESH_AFTER_MS = 24 * 3_600_000;
/** A pack older than this shows in the status line. */
export const SHOW_AGE_AFTER_MS = 24 * 3_600_000;

/** Is the connection unmetered? null when the browser does not say (no Network Information API). */
export function unmetered(conn?: { type?: string; saveData?: boolean } | null): boolean | null {
  if (!conn) return null;
  if (conn.saveData) return false;
  if (conn.type === "wifi" || conn.type === "ethernet") return true;
  if (conn.type === "cellular" || conn.type === "bluetooth" || conn.type === "wimax") return false;
  return null;
}

/** May an automatic sync refresh packs now? */
export const autoRefreshAllowed = (conn: boolean | null, mobileData: boolean) => conn === true || mobileData;

/** The packs a sync refreshes: on Sync now every one; automatically the aged ones not backing off. */
export function packsToRefresh(
  packs: PackMeta[],
  now: number,
  opts: { manual: boolean; backoffUntil?: ReadonlyMap<string, number> },
): PackMeta[] {
  return packs.filter(
    (p) =>
      !p.auto &&
      p.area != null &&
      (opts.manual || (now - p.refreshedAt > AUTO_REFRESH_AFTER_MS && (opts.backoffUntil?.get(p.id) ?? 0) <= now)),
  );
}

export interface SyncStatus {
  /** Logs waiting to be sent to this instance. */
  queued: number;
  /** Logs waiting for another instance (signed for it; they go only there). */
  elsewhere: number;
  attention: number;
  /** The oldest of the user's packs, when it is old enough to mention. */
  oldestPack: { name: string; ageMs: number } | null;
}

/** "3 logs waiting · 1 needs attention · pack 'JN77sb' 2 days old"; empty when there is nothing to say. */
export function statusLine(s: SyncStatus): string {
  const parts: string[] = [];
  if (s.queued) parts.push(`${s.queued} ${s.queued === 1 ? "log" : "logs"} waiting`);
  if (s.elsewhere) parts.push(`${s.elsewhere} for another instance`);
  if (s.attention) parts.push(`${s.attention} ${s.attention === 1 ? "needs" : "need"} attention`);
  if (s.oldestPack) {
    const days = Math.floor(s.oldestPack.ageMs / 86_400_000);
    const age =
      days >= 1
        ? `${days} ${days === 1 ? "day" : "days"}`
        : `${Math.max(1, Math.round(s.oldestPack.ageMs / 3_600_000))} h`;
    parts.push(`pack “${s.oldestPack.name}” ${age} old`);
  }
  return parts.join(" · ");
}

/** The oldest user pack worth mentioning. */
export function oldestPack(packs: PackMeta[], now: number): SyncStatus["oldestPack"] {
  const own = packs.filter((p) => !p.auto).sort((a, b) => a.refreshedAt - b.refreshedAt)[0];
  return own && now - own.refreshedAt > SHOW_AGE_AFTER_MS ? { name: own.name, ageMs: now - own.refreshedAt } : null;
}
