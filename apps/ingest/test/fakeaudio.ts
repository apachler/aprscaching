// SPDX-License-Identifier: AGPL-3.0-or-later
// Fakes for the soundcard port's tests: arecord / aplay processes, a recording PTT and a gpioset spy. No sound
// card, no radio.
import { EventEmitter } from "node:events";
import type { AudioChild, AudioSpawn } from "../src/alsa.js";
import type { Ptt } from "../src/ptt/index.js";

/** How a fake aplay behaves: exit 0 once stdin ends, hang until killed, or fail to spawn (`error`, no exit). */
type AplayMode = "ok" | "hang" | "spawn-error";

export class FakeChild extends EventEmitter implements AudioChild {
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: Buffer[] = [];
  killed: string[] = [];
  stdin: AudioChild["stdin"];

  constructor(
    readonly cmd: string,
    readonly args: string[],
    mode: AplayMode = "ok",
  ) {
    super();
    const stdinEvents = new EventEmitter();
    this.stdin = {
      write: (b: Uint8Array) => {
        this.written.push(Buffer.from(b));
        return true;
      },
      end: () => {
        if (mode === "ok") setImmediate(() => this.exit(0));
      },
      on: (event: "error", cb: (e: Error) => void) => stdinEvents.on(event, cb),
    };
    if (mode === "spawn-error")
      setImmediate(() => this.emit("error", Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" })));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? -1;
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** arecord: deliver captured bytes. */
  feed(b: Buffer): void {
    this.stdout.emit("data", b);
  }
}

/** A spawner that records every child. */
export function fakeSpawner(o: { aplay?: AplayMode; arecord?: "ok" | "spawn-error" } = {}) {
  const children: FakeChild[] = [];
  const spawn: AudioSpawn = (cmd, args) => {
    const c = new FakeChild(cmd, args, cmd === "aplay" ? (o.aplay ?? "ok") : (o.arecord ?? "ok"));
    children.push(c);
    return c;
  };
  return {
    spawn,
    children,
    arecord: () => children.filter((c) => c.cmd === "arecord"),
    aplay: () => children.filter((c) => c.cmd === "aplay"),
  };
}

/** A PTT that records its calls in order. */
export function recordingPtt(events: string[] = []): Ptt & { events: string[] } {
  return {
    events,
    label: "fake",
    key: async () => void events.push("key"),
    unkey: async () => void events.push("unkey"),
    close: async () => void events.push("close"),
    releaseSync: () => void events.push("releaseSync"),
  };
}

/**
 * A fake `gpioset`: each held spawn is a child until killed, `--version` names the libgpiod version, and a
 * one-shot set is recorded. `log` keeps the order of events; `level()` is the level the line is driven at (the
 * live holder's, else the last one-shot's). `onceBusy` / `holdBusy` make that many requests fail as busy.
 */
export function gpiosetSpy(version: string, o: { onceBusy?: number; holdBusy?: number; onceFails?: boolean } = {}) {
  type Kid = EventEmitter & {
    exitCode: number | null;
    stderr: EventEmitter;
    value: string;
    killedWith?: string;
    kill(sig?: string): boolean;
  };
  const calls: string[][] = [];
  const once: string[][] = [];
  const kids: Kid[] = [];
  const log: string[] = [];
  let onceBusy = o.onceBusy ?? 0;
  let holdBusy = o.holdBusy ?? 0;
  let lastOnce: string | null = null;
  const valueOf = (args: string[]) => args[args.length - 1]!.split("=")[1]!;
  const spawn = (_cmd: string, args: string[]) => {
    calls.push(args);
    const k = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      stderr: new EventEmitter(),
      value: valueOf(args),
      kill(sig?: string) {
        if (k.exitCode !== null) return false;
        k.killedWith ??= sig;
        log.push(`kill ${k.value} ${sig}`);
        setImmediate(() => {
          if (k.exitCode !== null) return;
          k.exitCode = 0;
          k.emit("exit", null);
        });
        return true;
      },
    }) as Kid;
    kids.push(k);
    log.push(`hold ${k.value}`);
    const busy = holdBusy > 0;
    if (busy) holdBusy--;
    setImmediate(() => {
      k.emit("spawn");
      if (busy) {
        k.stderr.emit("data", Buffer.from("gpioset: unable to request lines: Device or resource busy"));
        k.exitCode = 1;
        k.emit("exit", 1);
      }
    });
    return k;
  };
  const spawnSync = (_cmd: string, args: string[]) => {
    if (args[0] === "--version") return { status: 0, stdout: `gpioset (libgpiod) ${version}\n` };
    once.push(args);
    if (o.onceFails) {
      log.push("once failed");
      return { status: 1, stderr: "gpioset: unable to find chip" };
    }
    if (onceBusy > 0) {
      onceBusy--;
      log.push("once busy");
      return { status: 1, stderr: "gpioset: unable to request lines: Device or resource busy" };
    }
    lastOnce = valueOf(args);
    log.push(`once ${lastOnce}`);
    return { status: 0 };
  };
  const live = () => kids.filter((k) => k.exitCode === null && k.killedWith === undefined);
  const level = () => live().at(-1)?.value ?? lastOnce;
  return { calls, once, kids, log, live, level, spawn, spawnSync };
}
