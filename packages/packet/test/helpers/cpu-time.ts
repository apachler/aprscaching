// SPDX-License-Identifier: MIT
// The CPU time a call spends on this thread, for the tests that hold a text scan to linear time. Wall-clock
// time stretches with everything else the machine runs, so a wall-clock bound fails a linear scan on a loaded
// box; the thread's own CPU time does not stretch, and a catastrophic scan still overshoots any bound by
// orders of magnitude. Outside Node the clock falls back to wall-clock time.
type Usage = { user: number; system: number };
type Clock = (prior?: Usage) => Usage;

// the packages build without Node types, so the clock is read through globalThis
const proc = (globalThis as { process?: { threadCpuUsage?: Clock; cpuUsage?: Clock } }).process;
const usage: Clock | undefined = proc?.threadCpuUsage?.bind(proc) ?? proc?.cpuUsage?.bind(proc);

/** Run `fn` once: its value and the milliseconds of CPU it took. */
export function cpuTimed<T>(fn: () => T): { value: T; ms: number } {
  if (!usage) {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: performance.now() - t0 };
  }
  const u0 = usage();
  const value = fn();
  const u = usage(u0);
  return { value, ms: (u.user + u.system) / 1000 };
}
