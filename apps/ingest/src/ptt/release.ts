// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release every PTT when the process stops:
 *  - on SIGINT and SIGTERM, an asynchronous unkey of every PTT still open, while the ingest stops its ports;
 *  - on an uncaught exception (the ingest logs it and keeps running, but a fault in a transmit path must not
 *    leave the radio keyed), the same, after a synchronous release;
 *  - on `exit`, the synchronous release of every PTT the process ever opened, closed or not: a close that did
 *    not finish, or one that raced the exit, still ends at the unkeyed level where the driver has a way.
 * A SIGKILL, an out-of-memory kill or a power cut runs none of this: the PTT then stays as it was, and only
 * the radio's own transmit time-out ends a transmission.
 */
import type { Ptt } from "./types.js";

interface ProcessLike {
  on(event: "exit", cb: () => void): unknown;
  on(event: "SIGINT" | "SIGTERM", cb: () => void): unknown;
  on(event: "uncaughtException", cb: (e: Error) => void): unknown;
}

/** PTTs not yet closed: unkeyed on a stop signal. */
const open = new Set<Ptt>();
/** Every PTT the process opened: released synchronously at exit. */
const opened = new Set<Ptt>();
const installed = new WeakSet<object>();

/** Register a PTT for release on stop and at exit. */
export function trackPtt(p: Ptt): void {
  open.add(p);
  opened.add(p);
}

/** A PTT whose close resolved: no further unkey on a signal (its synchronous release still runs at exit). */
export function untrackPtt(p: Ptt): void {
  open.delete(p);
}

/** Forget a PTT entirely (tests). */
export function forgetPtt(p: Ptt): void {
  open.delete(p);
  opened.delete(p);
}

/** Unkey every open PTT; resolves when each driver answered (or failed). */
export async function releaseAllPtt(): Promise<void> {
  await Promise.all(
    [...open].map((p) =>
      p.unkey().catch((e: Error) => console.error(`[ptt] could not unkey ${p.label}: ${e.message}`)),
    ),
  );
}

/** Release every PTT the process opened through the drivers' synchronous paths. */
export function releaseAllSync(): void {
  for (const p of opened) {
    try {
      p.releaseSync?.();
    } catch (e) {
      console.error(`[ptt] exit release of ${p.label} failed: ${(e as Error).message}`);
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
    for (const p of open) {
      try {
        p.releaseSync?.();
      } catch {
        /* the asynchronous unkey below still runs */
      }
    }
    void releaseAllPtt();
  });
}
