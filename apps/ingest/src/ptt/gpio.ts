// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT on a Linux GPIO line (a Raspberry Pi header pin, or any board's GPIO), through the GPIO character
 * device with libgpiod's `gpioset` (Debian, Ubuntu and Raspberry Pi OS package `gpiod`). Node cannot issue
 * the character device's ioctls without a native addon, and the old `/sys/class/gpio` interface is gone from
 * current kernels, so the box runs `gpioset` as a child process.
 *
 * A line is driven only while a process holds it; once the holder exits, libgpiod documents the level as
 * undefined (many drivers keep it, some return the line to its default). So one `gpioset` always holds the
 * line: at the unkeyed level while idle, swapped for one at the keyed level to transmit. Two processes cannot
 * hold one line, so a swap ends the old holder before the new one requests the line, and retries while the
 * kernel still reports it busy. Wire the PTT so the line's default level is unkeyed (a pull resistor on the
 * keying transistor): that is the level after the ingest is gone.
 *
 * Every change runs under one lock, so a key, an unkey and a close never overlap, and a holder still starting
 * is tracked. Both libgpiod generations work: version 1 holds with `--mode=signal`, version 2 holds by default
 * and takes the chip with `-c`. Process exit kills the holder and sets the unkeyed level once more with a
 * one-shot `gpioset`, whose exit status is checked.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import type { Ptt } from "./types.js";

/** The part of a ChildProcess the driver uses. */
export interface GpioChild {
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  on(event: "spawn", cb: () => void): unknown;
  stderr: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
}
export type GpioSpawn = (cmd: string, args: string[]) => GpioChild;
export type GpioSpawnSync = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error };

/** How long a fresh holder must keep running before its level counts as set; `gpioset` exits at once on an error. */
const SETTLE_MS = 40;
/** The longest a holder may take to start, or to exit once told to. */
const STEP_MS = 1500;
/** Attempts while the line is still busy with the holder that is exiting. */
const BUSY_TRIES = 5;

/** The libgpiod major version of `gpioset`, or an error that says how to install it. */
export function gpiosetVersion(spawnSync: GpioSpawnSync): 1 | 2 {
  const r = spawnSync("gpioset", ["--version"]);
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT" ? "gpioset not found: install libgpiod's tools (apt install gpiod)" : r.error.message,
    );
  }
  const m = /v?(\d+)\.\d+/.exec(String(r.stdout ?? ""));
  return m && Number(m[1]) >= 2 ? 2 : 1;
}

/** The arguments that hold `line` of `chip` at `value` until the process is killed. */
export function gpiosetHoldArgs(version: 1 | 2, chip: string, line: number, value: 0 | 1): string[] {
  return version >= 2 ? ["-c", chip, `${line}=${value}`] : ["--mode=signal", chip, `${line}=${value}`];
}

/** The arguments that set `line` once and exit. */
function gpiosetOnceArgs(version: 1 | 2, chip: string, line: number, value: 0 | 1): string[] {
  return version >= 2 ? ["-t0", "-c", chip, `${line}=${value}`] : [chip, `${line}=${value}`];
}

const busy = (text: string) => /busy/i.test(text);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A short wait inside synchronous code (process exit), where no timer can run. */
const pauseSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export async function openGpioPtt(
  o: { chip: string; line: number; invert: boolean },
  deps: { spawn?: GpioSpawn; spawnSync?: GpioSpawnSync; settleMs?: number; stepMs?: number } = {},
): Promise<Ptt> {
  const spawn: GpioSpawn = deps.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["ignore", "ignore", "pipe"] }));
  const spawnSync: GpioSpawnSync = deps.spawnSync ?? ((c, a) => nodeSpawnSync(c, a, { encoding: "utf8" }));
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const stepMs = deps.stepMs ?? STEP_MS;
  const version = gpiosetVersion(spawnSync);
  const level = (on: boolean): 0 | 1 => ((on ? !o.invert : o.invert) ? 1 : 0);
  /** The holder, and the level it holds. */
  let holder: { child: GpioChild; on: boolean } | null = null;
  /** A holder still starting: a close or an exit must end it too. */
  let starting: GpioChild | null = null;
  let closed = false;
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  const alive = (c: GpioChild) => c.exitCode === null && !c.signalCode;

  /** End `c` and wait until it has released the line; SIGKILL when SIGTERM is not enough. */
  const end = async (c: GpioChild) => {
    if (!alive(c)) return;
    const gone = new Promise<void>((res) => c.on("exit", () => res()));
    c.kill("SIGTERM");
    const ok = await Promise.race([gone.then(() => true), pause(stepMs).then(() => false)]);
    if (ok) return;
    c.kill("SIGKILL");
    await Promise.race([gone, pause(stepMs)]);
  };

  /** Start a holder at the level for `on`; rejects with gpioset's message when it exits at once. */
  const start = async (on: boolean): Promise<GpioChild> => {
    let last = "";
    for (let attempt = 0; attempt < BUSY_TRIES; attempt++) {
      const child = spawn("gpioset", gpiosetHoldArgs(version, o.chip, o.line, level(on)));
      starting = child;
      let stderr = "";
      child.stderr?.on("data", (b) => (stderr = (stderr + b.toString()).slice(-4096)));
      try {
        await new Promise<void>((res, rej) => {
          let settled = false;
          const done = (e?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (e) rej(e);
            else res();
          };
          const timer = setTimeout(() => done(new Error(`gpioset did not start within ${stepMs} ms`)), stepMs);
          child.on("error", (e) => done(new Error(`gpioset: ${e.message}`)));
          child.on("exit", (code) =>
            done(
              new Error(`gpioset exited (${code}) setting ${o.chip} line ${o.line}: ${stderr.trim() || "no message"}`),
            ),
          );
          child.on("spawn", () => setTimeout(() => done(), settleMs));
        });
        return child;
      } catch (e) {
        last = (e as Error).message;
        await end(child);
        if (!busy(last)) break;
        await pause(20 * (attempt + 1)); // the old holder is still releasing the line
      } finally {
        if (starting === child) starting = null;
      }
    }
    throw new Error(last);
  };

  /** Hold the line at the level for `on`. */
  const hold = (on: boolean) =>
    locked(async () => {
      if (closed) throw new Error("GPIO PTT is closed");
      if (holder && holder.on === on && alive(holder.child)) return;
      if (holder) await end(holder.child);
      holder = null;
      holder = { child: await start(on), on };
    });

  /** Set the unkeyed level once and exit, checking that it worked; retries while the line is still busy. */
  const onceUnkeyed = () => {
    let last = "";
    for (let attempt = 0; attempt < BUSY_TRIES; attempt++) {
      const r = spawnSync("gpioset", gpiosetOnceArgs(version, o.chip, o.line, level(false)));
      if (r.status === 0 && !r.error) return;
      last = r.error?.message ?? (String(r.stderr ?? "").trim() || `exit ${r.status}`);
      if (!busy(last)) break;
      pauseSync(20 * (attempt + 1));
    }
    throw new Error(`gpioset could not set ${o.chip} line ${o.line} unkeyed: ${last}`);
  };

  await hold(false);
  return {
    label: `GPIO ${o.chip} line ${o.line}${o.invert ? " (active low)" : ""}`,
    key: () => hold(true),
    unkey: async () => {
      try {
        await hold(false);
      } catch (e) {
        // no idle holder: end any keyed one and set the level directly
        await locked(async () => {
          if (holder) await end(holder.child);
          holder = null;
          onceUnkeyed();
        });
        console.error(`[ptt] GPIO idle holder failed (${(e as Error).message}); the line was set unkeyed once`);
      }
    },
    close: () =>
      locked(async () => {
        if (closed) return;
        closed = true;
        // no holder survives a close, keyed or starting; the line is set unkeyed on the way out
        if (starting) await end(starting);
        if (holder) await end(holder.child);
        holder = null;
        onceUnkeyed();
      }),
    releaseSync: () => {
      starting?.kill("SIGKILL");
      if (holder) holder.child.kill("SIGKILL");
      holder = null;
      onceUnkeyed();
    },
  };
}
