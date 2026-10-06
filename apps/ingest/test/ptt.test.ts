// SPDX-License-Identifier: AGPL-3.0-or-later
// The PTT drivers against fakes (a serialport mock, a hidraw file in a temp dir, a gpioset spy, a rigctld
// TCP server), the spec parser, the watchdog and the release on process stop. No radio is keyed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { parsePttSpec, describePtt, openPtt, pttProblem } from "../src/ptt/index.js";
import { cm108Report, openCm108Ptt } from "../src/ptt/cm108.js";
import { openGpioPtt, gpiosetHoldArgs, type GpioChild } from "../src/ptt/gpio.js";
import { openRigctldPtt } from "../src/ptt/rigctld.js";
import { PttWatchdog } from "../src/ptt/watchdog.js";
import { installPttRelease, trackPtt, untrackPtt } from "../src/ptt/release.js";
import type { SerialLike, SerialPortCtor } from "../src/ptt/serialport.js";
import { recordingPtt } from "./fakeaudio.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ptt-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("parsePttSpec", () => {
  it.each([
    ["", { kind: "none" }],
    ["none", { kind: "none" }],
    ["VOX", { kind: "none" }],
    ["serial:/dev/ttyUSB0", { kind: "serial", path: "/dev/ttyUSB0", line: "rts", invert: false }],
    ["serial:/dev/ttyUSB0:-dtr", { kind: "serial", path: "/dev/ttyUSB0", line: "dtr", invert: true }],
    ["cat:/dev/ttyUSB1:icom", { kind: "cat", path: "/dev/ttyUSB1", rig: "icom", baud: 19200 }],
    ["cat:/dev/ttyUSB1:icom:9600:0xA4", { kind: "cat", path: "/dev/ttyUSB1", rig: "icom", baud: 9600, icomAddr: 0xa4 }],
    ["cat:/dev/ttyUSB1:yaesu-bin", { kind: "cat", path: "/dev/ttyUSB1", rig: "yaesu-bin", baud: 4800 }],
    ["rigctld", { kind: "rigctld", host: "127.0.0.1", port: 4532 }],
    ["rigctld:192.168.1.5:4533", { kind: "rigctld", host: "192.168.1.5", port: 4533 }],
    ["cm108", { kind: "cm108", path: "/dev/hidraw0", gpio: 3 }],
    ["cm108:/dev/hidraw2:4", { kind: "cm108", path: "/dev/hidraw2", gpio: 4 }],
    ["gpio:gpiochip0:17", { kind: "gpio", chip: "gpiochip0", line: 17, invert: false }],
    ["gpio:gpiochip4:-27", { kind: "gpio", chip: "gpiochip4", line: 27, invert: true }],
  ])("%s", (raw, spec) => {
    expect(parsePttSpec(raw)).toEqual(spec);
  });

  it.each([
    ["serial", /name the serial device/],
    ["serial:/dev/ttyUSB0:cts", /rts, dtr/],
    ["cat:/dev/ttyUSB0:elecraft", /kenwood, icom or yaesu-bin/],
    ["cm108:/dev/hidraw0:9", /GPIO must be a whole number from 1 to 8/],
    ["gpio:gpiochip0", /name the chip and the line/],
    ["rigctld:host:0", /port must be/],
    ["parallel:0x378", /the driver is none/],
  ])("refuses %s", (raw, msg) => {
    expect(() => parsePttSpec(raw)).toThrow(msg);
  });

  it("describes each driver", () => {
    expect(describePtt(parsePttSpec("cm108"))).toBe("CM108 /dev/hidraw0 GPIO3");
    expect(describePtt(parsePttSpec("serial:/dev/ttyS0:-rts"))).toBe("serial /dev/ttyS0 -RTS");
  });
});

/** A serialport mock that records control-line changes and writes. */
function serialMock() {
  const log: { path?: string; baudRate?: number; sets: object[]; writes: number[][]; closed: boolean } = {
    sets: [],
    writes: [],
    closed: false,
  };
  class Mock extends EventEmitter implements SerialLike {
    constructor(o: { path: string; baudRate: number }) {
      super();
      log.path = o.path;
      log.baudRate = o.baudRate;
    }
    open(cb: (e: Error | null) => void) {
      setImmediate(() => cb(null));
    }
    set(s: object, cb: (e: Error | null) => void) {
      log.sets.push(s);
      setImmediate(() => cb(null));
    }
    write(d: Uint8Array, cb?: (e: Error | null | undefined) => void) {
      log.writes.push([...d]);
      setImmediate(() => cb?.(null));
      return true;
    }
    drain(cb: (e: Error | null) => void) {
      setImmediate(() => cb(null));
    }
    close(cb: (e: Error | null) => void) {
      log.closed = true;
      setImmediate(() => cb(null));
    }
  }
  return { log, ctor: Mock as unknown as SerialPortCtor };
}

describe("serial RTS/DTR PTT", () => {
  it("drives the line unkeyed at open, then asserts and drops it", async () => {
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec("serial:/dev/ttyUSB0:rts"), { loadSerialPort: async () => m.ctor });
    await ptt.key();
    await ptt.unkey();
    await ptt.close();
    expect(m.log.path).toBe("/dev/ttyUSB0");
    expect(m.log.sets).toEqual([{ rts: false }, { rts: true }, { rts: false }, { rts: false }]);
    expect(m.log.closed).toBe(true);
  });

  it("inverts -dtr", async () => {
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec("serial:/dev/ttyUSB0:-dtr"), { loadSerialPort: async () => m.ctor });
    await ptt.key();
    expect(m.log.sets).toEqual([{ dtr: true }, { dtr: false }]);
  });

  it("says how to install serialport when it is missing", async () => {
    await expect(
      openPtt(parsePttSpec("serial:/dev/ttyUSB0"), {
        loadSerialPort: async () => {
          throw new Error("the optional 'serialport' package is not installed");
        },
      }),
    ).rejects.toThrow(/serialport/);
  });
});

describe("CAT PTT", () => {
  it("writes the rig family's key and unkey commands at its baud rate", async () => {
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec("cat:/dev/ttyUSB1:icom:19200:0x94"), { loadSerialPort: async () => m.ctor });
    await ptt.key();
    await ptt.unkey();
    expect(m.log.baudRate).toBe(19200);
    const hex = m.log.writes.map((w) => w.map((b) => b.toString(16).padStart(2, "0")).join(" "));
    expect(hex).toEqual(["fe fe 94 e0 1c 00 00 fd", "fe fe 94 e0 1c 00 01 fd", "fe fe 94 e0 1c 00 00 fd"]);
  });

  it("unkeys synchronously by writing to the device on exit", async () => {
    const dev = path.join(tmpDir(), "ttyUSB1");
    fs.writeFileSync(dev, "");
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec(`cat:${dev}:kenwood`), { loadSerialPort: async () => m.ctor });
    ptt.releaseSync!();
    expect(fs.readFileSync(dev, "utf8")).toBe("RX;");
  });
});

describe("CM108 PTT", () => {
  it("builds Direwolf's HID output report", () => {
    expect([...cm108Report(3, true)]).toEqual([0, 0, 4, 4, 0]);
    expect([...cm108Report(3, false)]).toEqual([0, 0, 4, 0, 0]);
    expect([...cm108Report(1, true)]).toEqual([0, 0, 1, 1, 0]);
  });

  it("writes the report to the hidraw device: unkeyed at open, keyed, unkeyed, and on exit", async () => {
    const dev = path.join(tmpDir(), "hidraw0");
    fs.writeFileSync(dev, "");
    const writes: number[][] = [];
    const fsx = {
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      writeSync: ((fd: number, b: Uint8Array) => {
        writes.push([...b]);
        return fs.writeSync(fd, b);
      }) as typeof fs.writeSync,
    };
    const ptt = openCm108Ptt({ path: dev, gpio: 3 }, fsx);
    await ptt.key();
    await ptt.unkey();
    ptt.releaseSync!();
    await ptt.close();
    expect(writes).toEqual([
      [0, 0, 4, 0, 0],
      [0, 0, 4, 4, 0],
      [0, 0, 4, 0, 0],
      [0, 0, 4, 0, 0],
      [0, 0, 4, 0, 0],
    ]);
    expect(fs.statSync(dev).size).toBe(25);
  });

  it("names the udev fix when the device is not writable", () => {
    const fsx = {
      openSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      writeSync: fs.writeSync,
      closeSync: fs.closeSync,
    } as unknown as typeof fs;
    expect(() => openCm108Ptt({ path: "/dev/hidraw0", gpio: 3 }, fsx)).toThrow(/udev rule/);
  });

  it("the availability check reports a missing device", async () => {
    expect(await pttProblem(parsePttSpec(`cm108:${path.join(tmpDir(), "none")}`))).toMatch(/does not exist/);
    const dev = path.join(tmpDir(), "hidraw1");
    fs.writeFileSync(dev, "");
    expect(await pttProblem(parsePttSpec(`cm108:${dev}`))).toBeNull();
  });
});

/** A gpioset spy: each spawn is a held child until killed. */
function gpiosetSpy(version: string) {
  const calls: string[][] = [];
  const once: string[][] = [];
  const kids: (EventEmitter & GpioChild & { killedWith?: string })[] = [];
  const spawn = (_cmd: string, args: string[]) => {
    calls.push(args);
    const k = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      stderr: new EventEmitter(),
      kill(sig?: string) {
        k.killedWith = sig;
        setImmediate(() => {
          k.exitCode = 0;
          k.emit("exit", null);
        });
        return true;
      },
    }) as unknown as EventEmitter & GpioChild & { killedWith?: string };
    kids.push(k);
    setImmediate(() => k.emit("spawn"));
    return k;
  };
  const spawnSync = (_cmd: string, args: string[]) => {
    if (args[0] === "--version") return { status: 0, stdout: `gpioset (libgpiod) ${version}\n` };
    once.push(args);
    return { status: 0 };
  };
  return { calls, once, kids, spawn, spawnSync };
}

describe("GPIO PTT (gpioset)", () => {
  it("holds the line with libgpiod 2's arguments, swapping the holder to key and unkey", async () => {
    const g = gpiosetSpy("v2.1.1");
    const ptt = await openGpioPtt({ chip: "gpiochip0", line: 17, invert: false }, { ...g, settleMs: 1 });
    await ptt.key();
    await ptt.unkey();
    expect(g.calls).toEqual([
      ["-c", "gpiochip0", "17=0"],
      ["-c", "gpiochip0", "17=1"],
      ["-c", "gpiochip0", "17=0"],
    ]);
    // each holder was released before the next one took the line
    expect(g.kids.slice(0, 2).map((k) => k.killedWith)).toEqual(["SIGTERM", "SIGTERM"]);
    ptt.releaseSync!();
    expect(g.kids[2]!.killedWith).toBe("SIGKILL");
    expect(g.once).toEqual([["-t0", "-c", "gpiochip0", "17=0"]]);
  });

  it("uses libgpiod 1's signal mode, and inverts an active-low line", async () => {
    const g = gpiosetSpy("v1.6.3");
    const ptt = await openGpioPtt({ chip: "gpiochip0", line: 27, invert: true }, { ...g, settleMs: 1 });
    await ptt.key();
    expect(g.calls).toEqual([
      ["--mode=signal", "gpiochip0", "27=1"],
      ["--mode=signal", "gpiochip0", "27=0"],
    ]);
    expect(gpiosetHoldArgs(1, "gpiochip0", 5, 1)).toEqual(["--mode=signal", "gpiochip0", "5=1"]);
  });

  it("rejects when gpioset exits at once (a wrong chip or a busy line)", async () => {
    const spawn = () => {
      const k = Object.assign(new EventEmitter(), {
        exitCode: null,
        stderr: new EventEmitter(),
        kill: () => true,
      }) as unknown as EventEmitter & GpioChild;
      setImmediate(() => {
        k.emit("spawn");
        (k.stderr as unknown as EventEmitter).emit(
          "data",
          Buffer.from("gpioset: unable to request lines: Device or resource busy"),
        );
        k.emit("exit", 1);
      });
      return k;
    };
    const spawnSync = () => ({ status: 0, stdout: "v2.1" });
    await expect(
      openGpioPtt({ chip: "gpiochip0", line: 17, invert: false }, { spawn, spawnSync, settleMs: 20 }),
    ).rejects.toThrow(/resource busy/);
  });

  it("names the package when gpioset is missing", async () => {
    const spawnSync = () => ({
      status: null,
      error: Object.assign(new Error("spawnSync gpioset ENOENT"), { code: "ENOENT" }),
    });
    await expect(openGpioPtt({ chip: "gpiochip0", line: 17, invert: false }, { spawnSync })).rejects.toThrow(
      /apt install gpiod/,
    );
  });
});

describe("rigctld PTT", () => {
  async function fakeRigctld(reply: (line: string) => string) {
    const lines: string[] = [];
    const server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => {
        for (const l of d.split("\n").filter(Boolean)) {
          lines.push(l);
          sock.write(reply(l));
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    return { port: (server.address() as net.AddressInfo).port, lines };
  }

  it("sends T 0 at open, T 1 to key and T 0 to unkey", async () => {
    const d = await fakeRigctld(() => "RPRT 0\n");
    const ptt = await openRigctldPtt({ host: "127.0.0.1", port: d.port });
    await ptt.key();
    await ptt.unkey();
    await ptt.close();
    expect(d.lines).toEqual(["T 0", "T 1", "T 0", "T 0"]);
  });

  it("rejects a refused command", async () => {
    const d = await fakeRigctld((l) => (l === "T 1" ? "RPRT -11\n" : "RPRT 0\n"));
    const ptt = await openRigctldPtt({ host: "127.0.0.1", port: d.port });
    await expect(ptt.key()).rejects.toThrow(/RPRT -11/);
    await ptt.close();
  });

  it("rejects when rigctld is not running", async () => {
    await expect(openRigctldPtt({ host: "127.0.0.1", port: 1 })).rejects.toThrow(/does not answer/);
  });
});

describe("PttWatchdog", () => {
  it("releases a PTT keyed too long, faults, and refuses further keys", async () => {
    vi.useFakeTimers();
    try {
      const inner = recordingPtt();
      const faults: string[] = [];
      const w = new PttWatchdog(inner, { maxKeyMs: 10_000, onFault: (r) => faults.push(r) });
      await w.key();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(faults).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(faults[0]).toMatch(/keyed longer than 10000 ms/);
      expect(inner.events).toEqual(["key", "releaseSync", "unkey"]);
      expect(w.isKeyed).toBe(false);
      await expect(w.key()).rejects.toThrow(/locked out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trip when the PTT is released in time", async () => {
    vi.useFakeTimers();
    try {
      const faults: string[] = [];
      const w = new PttWatchdog(recordingPtt(), { maxKeyMs: 1000, onFault: (r) => faults.push(r) });
      await w.key();
      await vi.advanceTimersByTimeAsync(500);
      await w.unkey();
      await vi.advanceTimersByTimeAsync(5000);
      expect(faults).toEqual([]);
      expect(w.fault).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unkeys and rethrows when keying fails", async () => {
    const inner = recordingPtt();
    inner.key = async () => {
      throw new Error("radio busy");
    };
    const w = new PttWatchdog(inner, { maxKeyMs: 1000, onFault: () => {} });
    await expect(w.key()).rejects.toThrow("radio busy");
    expect(inner.events).toEqual(["unkey"]);
  });
});

describe("release on process stop", () => {
  it("unkeys every open PTT on SIGTERM, SIGINT and an uncaught exception, and synchronously on exit", async () => {
    const proc = new EventEmitter();
    installPttRelease(proc as unknown as NodeJS.Process);
    installPttRelease(proc as unknown as NodeJS.Process); // once per process
    const a = recordingPtt();
    const b = recordingPtt();
    trackPtt(a);
    trackPtt(b);
    cleanups.push(() => {
      untrackPtt(a);
      untrackPtt(b);
    });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    proc.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(a.events).toEqual(["unkey"]);
    proc.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setImmediate(r));
    proc.emit("exit");
    expect(b.events).toEqual(["unkey", "unkey", "releaseSync", "unkey", "releaseSync"]);
    untrackPtt(b);
    proc.emit("exit");
    expect(b.events.filter((e) => e === "releaseSync")).toHaveLength(2);
  });
});
