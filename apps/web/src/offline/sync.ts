// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sync engine at work in the browser (the rules are in syncEngine.ts): flush the log queue, then
 * refresh the packs that are due, and report the state the top bar's status line shows.
 */
import { API_BASE, attentionLogs, flushLogQueue, getInstance, offlineReady, queuedLogs } from "../api.js";
import { refreshPack } from "./download.js";
import { userPacks } from "./packs.js";
import { autoRefreshAllowed, oldestPack, packsToRefresh, unmetered, type SyncStatus } from "./syncEngine.js";

const MOBILE_DATA_KEY = "acs.sync.mobileData";
const PACK_BACKOFF_FIRST_MS = 5 * 60_000;
const PACK_BACKOFF_MAX_MS = 6 * 3_600_000;

/** May packs refresh on mobile data? Off unless the user allowed it. */
export function mobileDataAllowed(): boolean {
  try {
    return localStorage.getItem(MOBILE_DATA_KEY) === "1";
  } catch {
    return false;
  }
}
export function setMobileDataAllowed(on: boolean): void {
  try {
    localStorage.setItem(MOBILE_DATA_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the default stays */
  }
}

const connection = () =>
  (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection ?? null;

/** Packs whose last refresh failed, and when each may be tried again (this page's lifetime). */
const backoffUntil = new Map<string, number>();
const failures = new Map<string, number>();

interface SyncReport {
  sent: number;
  refused: number;
  /** When a backed-off log is due again. */
  nextAt?: number;
  refreshed: number;
  refreshFailed: number;
}

let running: Promise<SyncReport> | null = null;

/** Sync now, or join the sync already running. `manual` refreshes every pack, whatever the connection. */
export function runSync(opts: { manual?: boolean } = {}): Promise<SyncReport> {
  running ??= syncOnce(!!opts.manual).finally(() => {
    running = null;
  });
  return running;
}

async function syncOnce(manual: boolean): Promise<SyncReport> {
  const logs = await flushLogQueue();
  const report: SyncReport = { ...logs, refreshed: 0, refreshFailed: 0 };
  if (!navigator.onLine) return report;
  if (!manual && !autoRefreshAllowed(unmetered(connection()), mobileDataAllowed())) return report;
  const store = await offlineReady();
  const now = Date.now();
  for (const pack of packsToRefresh(await userPacks(store), now, { manual, backoffUntil })) {
    try {
      await refreshPack(store, (u, i) => fetch(u, i), API_BASE, pack, Date.now());
      report.refreshed++;
      failures.delete(pack.id);
      backoffUntil.delete(pack.id);
    } catch {
      report.refreshFailed++;
      const n = (failures.get(pack.id) ?? 0) + 1;
      failures.set(pack.id, n);
      backoffUntil.set(pack.id, Date.now() + Math.min(PACK_BACKOFF_FIRST_MS * 2 ** (n - 1), PACK_BACKOFF_MAX_MS));
    }
  }
  if (report.refreshed) window.dispatchEvent(new Event("acs-packs"));
  return report;
}

/** What the status line shows: logs waiting (here and for another instance), refused ones, the oldest pack. */
export async function syncStatus(): Promise<SyncStatus> {
  const [queue, attention, instance] = await Promise.all([queuedLogs(), attentionLogs(), getInstance()]);
  const elsewhere = queue.filter((q) => instance && q.instance && q.instance !== instance).length;
  return {
    queued: queue.length - elsewhere,
    elsewhere,
    attention: attention.length,
    oldestPack: oldestPack(await userPacks(await offlineReady()), Date.now()),
  };
}
