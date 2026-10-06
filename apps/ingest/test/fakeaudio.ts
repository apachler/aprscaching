// SPDX-License-Identifier: AGPL-3.0-or-later
// Fake arecord / aplay processes and a recording PTT, for the soundcard port's tests: no sound card, no radio.
import { EventEmitter } from "node:events";
import type { AudioChild, AudioSpawn } from "../src/alsa.js";
import type { Ptt } from "../src/ptt/index.js";

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
    /** aplay: exit 0 once stdin ends (false: hang until killed, as a stuck playback would). */
    exitOnEnd = true,
  ) {
    super();
    const stdinEvents = new EventEmitter();
    this.stdin = {
      write: (b: Uint8Array) => {
        this.written.push(Buffer.from(b));
        return true;
      },
      end: () => {
        if (exitOnEnd) setImmediate(() => this.exit(0));
      },
      on: (event: "error", cb: (e: Error) => void) => stdinEvents.on(event, cb),
    };
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

/** A spawner that records every child; `aplayHangs` makes playback never end. */
export function fakeSpawner(o: { aplayHangs?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawn: AudioSpawn = (cmd, args) => {
    const c = new FakeChild(cmd, args, !o.aplayHangs);
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
