// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT on a Linux GPIO line (a Raspberry Pi header pin, or any board's GPIO), through the GPIO character
 * device with libgpiod's `gpioset` (Debian, Ubuntu and Raspberry Pi OS package `gpiod`). Node cannot issue
 * the character device's ioctls without a native addon, and the old `/sys/class/gpio` interface is gone from
 * current kernels, so the box runs `gpioset` as a child process.
 *
 * A line keeps its value only while a process holds it, so one `gpioset` always holds the line: at the
 * unkeyed level while idle, replaced by one at the keyed level to transmit. The idle holder drives the line
 * actively low (or high, inverted) instead of leaving it floating. Both libgpiod generations work: version 1
 * holds with `--mode=signal`, version 2 holds by default and takes the chip with `-c`. Process exit kills the
 * holder and sets the unkeyed level once more with a one-shot `gpioset`.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import type { Ptt } from "./types.js";

/** The part of a ChildProcess the driver uses. */
export interface GpioChild {
  readonly exitCode: number | null;
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
) => { status: number | null; stdout?: string | Buffer | null; error?: Error };

/** How long a fresh holder must keep running before its level counts as set; `gpioset` exits at once on an error. */
const SETTLE_MS = 40;

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

export async function openGpioPtt(
  o: { chip: string; line: number; invert: boolean },
  deps: { spawn?: GpioSpawn; spawnSync?: GpioSpawnSync; settleMs?: number } = {},
): Promise<Ptt> {
  const spawn: GpioSpawn = deps.spawn ?? ((c, a) => nodeSpawn(c, a, { stdio: ["ignore", "ignore", "pipe"] }));
  const spawnSync: GpioSpawnSync = deps.spawnSync ?? ((c, a) => nodeSpawnSync(c, a, { encoding: "utf8" }));
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const version = gpiosetVersion(spawnSync);
  const level = (on: boolean): 0 | 1 => ((on ? !o.invert : o.invert) ? 1 : 0);
  let holder: GpioChild | null = null;
  let closed = false;

  /** Kill the current holder and wait until it has released the line. */
  const release = async () => {
    const h = holder;
    holder = null;
    if (!h || h.exitCode !== null) return;
    await new Promise<void>((res) => {
      h.on("exit", () => res());
      h.kill("SIGTERM");
    });
  };

  /** Hold the line at the level for `on`; rejects when gpioset refuses (a wrong chip, a busy line). */
  const hold = async (on: boolean) => {
    if (closed) throw new Error("GPIO PTT is closed");
    await release();
    const child = spawn("gpioset", gpiosetHoldArgs(version, o.chip, o.line, level(on)));
    let stderr = "";
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    await new Promise<void>((res, rej) => {
      let settled = false;
      const done = (e?: Error) => {
        if (settled) return;
        settled = true;
        if (e) rej(e);
        else res();
      };
      child.on("error", (e) => done(new Error(`gpioset: ${e.message}`)));
      child.on("exit", (code) =>
        done(new Error(`gpioset exited (${code}) setting ${o.chip} line ${o.line}: ${stderr.trim() || "no message"}`)),
      );
      child.on("spawn", () => setTimeout(() => done(), settleMs));
    });
    holder = child;
  };

  await hold(false);
  return {
    label: `GPIO ${o.chip} line ${o.line}${o.invert ? " (active low)" : ""}`,
    key: () => hold(true),
    unkey: () => hold(false),
    close: async () => {
      if (closed) return;
      await hold(false).catch(() => {});
      closed = true;
      await release();
    },
    releaseSync: () => {
      holder?.kill("SIGKILL");
      holder = null;
      spawnSync("gpioset", gpiosetOnceArgs(version, o.chip, o.line, level(false)));
    },
  };
}
