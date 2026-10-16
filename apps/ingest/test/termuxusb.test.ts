// SPDX-License-Identifier: AGPL-3.0-or-later
// The termux-usb PTT driver with a fake helper process speaking the helper's line protocol (KEY, UNKEY, QUIT
// answered OK or ERR on stderr, READY first, UNKEYED on the way out): requests and answers, a helper that does
// not answer, one that exits keyed or unkeyed, the port's watchdog on top, and the real Python helper refusing
// a descriptor that is no USB device.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describePtt, parsePttSpec, pttProblem } from "../src/ptt/index.js";
import { helperCommand, openTermuxUsbPtt, withPttMax, type UsbPttChild } from "../src/ptt/termuxusb.js";
import { PttWatchdog } from "../src/ptt/watchdog.js";
import type { PttSpec } from "../src/ptt/types.js";

const HELPER = fileURLToPath(new URL("../../../deploy/pocket/extras/usb_ptt.py", import.meta.url));
type Spec = Extract<PttSpec, { kind: "termux-usb" }>;
const spec = (o: Partial<Spec> = {}): Spec => ({
  kind: "termux-usb",
  device: "auto",
  method: "cp210x-rts",
  gpio: 3,
  ...o,
});

type Answer = "ok" | "err" | "never";
/** A helper under termux-usb: answers each line as `answers` says, and unkeys when its input ends or it is killed. */
class FakeHelper extends EventEmitter implements UsbPttChild {
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  got: string[] = [];
  killed: string[] = [];
  ended = false;
  stdin: UsbPttChild["stdin"];

  constructor(
    readonly args: string[],
    public answers: { ready?: Answer | string; KEY?: Answer; UNKEY?: Answer } = {},
  ) {
    super();
    this.stdin = {
      write: (s: string) => {
        for (const line of s.split("\n").filter(Boolean)) this.onLine(line);
        return true;
      },
      end: () => {
        if (this.ended) return;
        this.ended = true;
        setImmediate(() => this.leave(0, null));
      },
      on: () => this.stdin,
    };
    setImmediate(() => {
      const r = answers.ready ?? "ok";
      if (r === "ok") this.say("READY 10c4:ea60 CP210x RTS (interface 0)");
      else if (r === "never") return;
      else {
        this.stdout.emit("data", Buffer.from(`${r}\n`)); // termux-usb's own message, printed as it exits
        this.leave(1, null);
      }
    });
  }

  say(line: string): void {
    this.stderr.emit("data", Buffer.from(`${line}\n`));
  }

  onLine(line: string): void {
    if (this.exitCode !== null) return;
    this.got.push(line);
    if (line === "QUIT") return this.say("OK");
    const a = this.answers[line as "KEY" | "UNKEY"] ?? "ok";
    if (a === "ok") this.say("OK");
    else if (a === "err") this.say(`ERR ${line.toLowerCase()} failed: No such device`);
  }

  /** Exit as the helper does: the unkey on the way out, then gone. */
  leave(code: number | null, signal: NodeJS.Signals | null, unkeyed = true): void {
    if (this.exitCode !== null) return;
    if (unkeyed) this.say("UNKEYED");
    this.exitCode = code ?? 128;
    this.emit("exit", code, signal);
    this.emit("close");
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    setImmediate(() => this.leave(null, signal));
    return true;
  }
}

function rig(o: { devices?: string[][]; answers?: FakeHelper["answers"]; replyMs?: number } = {}) {
  const helpers: FakeHelper[] = [];
  // each listing takes the next device list; the last one stays
  const lists = [...(o.devices ?? [["/dev/bus/usb/001/002"]])];
  const spawnSync = (cmd: string, args: string[]) => {
    if (cmd === "termux-usb" && args[0] === "-l") {
      const now = lists.length > 1 ? lists.shift()! : lists[0]!;
      return { status: 0, stdout: JSON.stringify(now) };
    }
    return { status: 0, stdout: "Python 3.12.0\n" };
  };
  const spawn = (cmd: string, args: string[]) => {
    expect(cmd).toBe("termux-usb");
    const h = new FakeHelper(args, o.answers);
    helpers.push(h);
    return h;
  };
  const open = (s: Spec = spec()) =>
    openTermuxUsbPtt(s, {
      spawn,
      run: spawnSync,
      helper: HELPER,
      readyMs: 300,
      replyMs: o.replyMs ?? 300,
      restartMs: { first: 5, cap: 20 },
    });
  return { helpers, open, spawnSync };
}

describe("SOUNDCARD_PTT=termux-usb", () => {
  it("parses the device, the method and the GPIO", () => {
    expect(parsePttSpec("termux-usb")).toEqual({ kind: "termux-usb", device: "auto", method: "auto", gpio: 3 });
    expect(parsePttSpec("termux-usb:/dev/bus/usb/001/004:cp210x-rts")).toMatchObject({
      device: "/dev/bus/usb/001/004",
      method: "cp210x-rts",
    });
    expect(parsePttSpec("termux-usb:auto:cm108:4")).toMatchObject({ device: "auto", method: "cm108", gpio: 4 });
    expect(() => parsePttSpec("termux-usb:/dev/ttyUSB0")).toThrow(/\/dev\/bus\/usb\/001\/002/);
    expect(() => parsePttSpec("termux-usb:auto:rts")).toThrow(/the method is auto, cdc-dtr/);
    expect(() => parsePttSpec("termux-usb:auto:cdc-dtr:3")).toThrow(/cm108 method only/);
    expect(describePtt(parsePttSpec("termux-usb:auto:cm108"))).toBe("termux-usb auto cm108 GPIO3");
  });

  it("sets the helper's watchdog just behind the port's", () => {
    const s = withPttMax(spec(), 10_000) as Spec;
    expect(s.maxKeyMs).toBe(12_000);
    expect(helperCommand(s, "/x/usb_ptt.py")).toBe("python3 /x/usb_ptt.py --method cp210x-rts --gpio 3 --max-key 12");
    expect(withPttMax({ kind: "none" }, 10_000)).toEqual({ kind: "none" });
    expect(() => helperCommand(s, "/my dir/usb_ptt.py")).toThrow(/space/);
  });
});

describe("termux-usb PTT driver", () => {
  it("runs the helper through termux-usb, waits for READY, and keys and unkeys by request", async () => {
    const r = rig();
    const ptt = await r.open(withPttMax(spec(), 10_000) as Spec);
    const h = r.helpers[0]!;
    expect(h.args).toEqual([
      "-r",
      "-e",
      `python3 ${HELPER} --method cp210x-rts --gpio 3 --max-key 12`,
      "/dev/bus/usb/001/002",
    ]);
    expect(ptt.label).toBe("termux-usb /dev/bus/usb/001/002: 10c4:ea60 CP210x RTS (interface 0)");
    await ptt.key();
    await ptt.unkey();
    expect(h.got).toEqual(["KEY", "UNKEY"]);
    await ptt.close();
    expect(h.got).toEqual(["KEY", "UNKEY", "UNKEY", "QUIT"]);
    expect(h.ended).toBe(true);
  });

  it("refuses to open with termux-usb's own message, and with several devices attached", async () => {
    await expect(rig({ answers: { ready: "Permission denied." } }).open()).rejects.toThrow(/Permission denied\./);
    await expect(rig({ devices: [["/dev/bus/usb/001/002", "/dev/bus/usb/001/003"]] }).open()).rejects.toThrow(
      /several USB devices.*name the radio interface's path/,
    );
    await expect(rig({ devices: [[]] }).open()).rejects.toThrow(/no USB device is attached/);
    await expect(rig().open(spec({ device: "/dev/bus/usb/001/009" }))).rejects.toThrow(/is not attached/);
  });

  it("rejects a key the helper answers with ERR", async () => {
    const r = rig({ answers: { KEY: "err" } });
    const ptt = await r.open();
    await expect(ptt.key()).rejects.toThrow("key failed: No such device");
  });

  it("stops a helper that does not answer, and a later unkey waits for its UNKEYED", async () => {
    const r = rig({ answers: { KEY: "never" }, replyMs: 50 });
    const ptt = await r.open();
    await expect(ptt.key()).rejects.toThrow(/did not answer KEY within 50 ms/);
    expect(r.helpers[0]!.ended).toBe(true);
    await ptt.unkey(); // the helper reported UNKEYED as it exited
  });

  it("fails the unkey of a helper that died keyed, and the watchdog latches the fault", async () => {
    const r = rig();
    const faults: string[] = [];
    const errors: string[] = [];
    const ptt = new PttWatchdog(await r.open(), { maxKeyMs: 5000, opTimeoutMs: 400, onFault: (f) => faults.push(f) });
    await ptt.key();
    r.helpers[0]!.leave(null, "SIGKILL", false); // killed outright: no unkey on the way out
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await expect(ptt.unkey()).rejects.toThrow(/exited while the line may be keyed/);
    } finally {
      console.error = orig;
    }
    expect(ptt.fault).toMatch(/the unkey failed/);
    await expect(ptt.key()).rejects.toThrow(/locked out/);
  });

  it("starts the helper again after it exited unkeyed, finding a replugged device's new path", async () => {
    const r = rig({ devices: [["/dev/bus/usb/001/002"], ["/dev/bus/usb/001/005"]] });
    const ptt = await r.open();
    const orig = console.error;
    console.error = () => {};
    try {
      r.helpers[0]!.leave(3, null); // unplugged while idle: the unkey on its way out went through
      // a key meanwhile is refused at once instead of waiting on the restart
      await expect(ptt.key()).rejects.toThrow(/being started again/);
      const t0 = Date.now();
      while (!(r.helpers.length === 2 && /005/.test(ptt.label)) && Date.now() - t0 < 2000)
        await new Promise((res) => setTimeout(res, 5));
      await ptt.key();
    } finally {
      console.error = orig;
    }
    expect(r.helpers).toHaveLength(2);
    expect(r.helpers[1]!.args.at(-1)).toBe("/dev/bus/usb/001/005");
    expect(r.helpers[1]!.got).toEqual(["KEY"]);
    await ptt.close();
  });

  it("releases through the watchdog: the stopped helper's UNKEYED confirms the unkey", async () => {
    const r = rig();
    const faults: string[] = [];
    const errors: string[] = [];
    const ptt = new PttWatchdog(await r.open(), { maxKeyMs: 40, opTimeoutMs: 400, onFault: (f) => faults.push(f) });
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      await ptt.key();
      await new Promise((res) => setTimeout(res, 150));
    } finally {
      console.error = orig;
    }
    expect(faults[0]).toMatch(/keyed longer than 40 ms/);
    expect(r.helpers[0]!.killed).toContain("SIGTERM");
    expect(ptt.isKeyed).toBe(false);
    expect(errors.some((e) => /may still be keyed/.test(e))).toBe(false);
  });

  it("checks the driver without opening the device", async () => {
    const r = rig();
    expect(await pttProblem(spec(), { spawnSync: r.spawnSync })).toBeNull();
    const none = (cmd: string) =>
      cmd === "termux-usb"
        ? { status: null, error: Object.assign(new Error("spawn termux-usb ENOENT"), { code: "ENOENT" }) }
        : { status: 0 };
    expect(await pttProblem(spec(), { spawnSync: none })).toMatch(/termux-usb not found: install the Termux:API app/);
  });
});

const python = !nodeSpawnSync("python3", ["--version"]).error;

describe.skipIf(!python)("the USB PTT helper under a stand-in for termux-usb", () => {
  it("answers ERR when the descriptor is no USB device, and the driver reports it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usbptt-"));
    // a CP2102's descriptors in a plain file: it reads like a device, but no usbfs ioctl works on it
    const desc = Buffer.from([
      18, 1, 0, 2, 0, 0, 0, 64, 0xc4, 0x10, 0x60, 0xea, 0, 1, 1, 2, 3, 1, 9, 2, 18, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 2,
      0xff, 0, 0, 0,
    ]);
    fs.writeFileSync(path.join(dir, "device"), desc);
    // termux-usb's shape: -r -e <command> <device>; the command split at spaces, the descriptor appended, its
    // stdout captured until it exits
    const stand = path.join(dir, "termux-usb");
    fs.writeFileSync(
      stand,
      '#!/usr/bin/env bash\nset -u\nCMD="$3"\nexec 5<"$4"\nOUT="$($CMD 5)"\nprintf "%s" "$OUT"\n',
      { mode: 0o755 },
    );
    const spawn = (_cmd: string, args: string[]) =>
      nodeSpawn("bash", [stand, ...args], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as UsbPttChild;
    const spawnSync = (cmd: string) =>
      cmd === "termux-usb" ? { status: 0, stdout: JSON.stringify([path.join(dir, "device")]) } : { status: 0 };
    const s = spec({ device: "auto", method: "auto" });
    try {
      await expect(openTermuxUsbPtt(s, { spawn, run: spawnSync, helper: HELPER, readyMs: 5000 })).rejects.toThrow(
        /Inappropriate ioctl for device/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
