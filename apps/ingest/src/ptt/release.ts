// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release every open PTT when the process stops: on SIGINT and SIGTERM (an asynchronous unkey, while the
 * ingest flushes its batch), on an uncaught exception (the ingest logs it and keeps running, but a fault in a
 * transmit path must not leave the radio keyed), and on `exit`, where only a driver's synchronous release can
 * still run.
 */
import type { Ptt } from "./types.js";

interface ProcessLike {
  on(event: "exit", cb: () => void): unknown;
  on(event: "SIGINT" | "SIGTERM", cb: () => void): unknown;
  on(event: "uncaughtException", cb: (e: Error) => void): unknown;
}

const open = new Set<Ptt>();
const installed = new WeakSet<object>();

/** Register a PTT for release on stop. */
export function trackPtt(p: Ptt): void {
  open.add(p);
}

/** Forget a PTT that was closed. */
export function untrackPtt(p: Ptt): void {
  open.delete(p);
}

/** Unkey every open PTT; resolves when each driver answered (or failed). */
export async function releaseAllPtt(): Promise<void> {
  await Promise.all(
    [...open].map((p) =>
      p.unkey().catch((e: Error) => console.error(`[ptt] could not unkey ${p.label}: ${e.message}`)),
    ),
  );
}

/** Unkey every open PTT through the drivers' synchronous paths. */
function releaseAllSync(): void {
  for (const p of open) {
    try {
      p.releaseSync?.();
    } catch {
      /* exit goes on: nothing else can run now */
    }
  }
}

/** Install the stop handlers on `proc` (once per process object). */
export function installPttRelease(proc: ProcessLike = process): void {
  if (installed.has(proc)) return;
  installed.add(proc);
  proc.on("exit", releaseAllSync);
  proc.on("SIGINT", () => void releaseAllPtt());
  proc.on("SIGTERM", () => void releaseAllPtt());
  proc.on("uncaughtException", () => {
    releaseAllSync();
    void releaseAllPtt();
  });
}
