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
import { forgetPtt, installPttRelease, trackPtt, untrackPtt } from "../src/ptt/release.js";
import type { SerialLike, SerialPortCtor } from "../src/ptt/serialport.js";
import type { Ptt } from "../src/ptt/types.js";
import { gpiosetSpy, recordingPtt } from "./fakeaudio.js";

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
    ["serial:/dev/ttyUSB0", { kind: "serial", path: "/dev/ttyUSB0", line: "rts" }],
    ["serial:/dev/ttyUSB0:DTR", { kind: "serial", path: "/dev/ttyUSB0", line: "dtr" }],
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
    ["serial:/dev/ttyUSB0:cts", /rts or dtr/],
    // an inverted line keys the radio whenever nothing holds the port: at boot, after a crash
    ["serial:/dev/ttyUSB0:-rts", /inverted serial line keys the radio whenever no program holds the port/],
    ["serial:/dev/ttyUSB0:-dtr", /inverted/],
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
    expect(describePtt(parsePttSpec("serial:/dev/ttyS0:rts"))).toBe("serial /dev/ttyS0 RTS");
  });
});

/** A serialport mock that records the open options, control-line changes and writes. */
function serialMock(o: { hangDrain?: boolean } = {}) {
  const log: {
    path?: string;
    baudRate?: number;
    hupcl?: boolean;
    events: string[];
    sets: object[];
    writes: number[][];
    closed: boolean;
  } = { events: [], sets: [], writes: [], closed: false };
  class Mock extends EventEmitter implements SerialLike {
    constructor(opts: { path: string; baudRate: number; hupcl?: boolean }) {
      super();
      log.path = opts.path;
      log.baudRate = opts.baudRate;
      log.hupcl = opts.hupcl;
    }
    open(cb: (e: Error | null) => void) {
      log.events.push("open");
      setImmediate(() => cb(null));
    }
    set(s: object, cb: (e: Error | null) => void) {
      log.sets.push(s);
      log.events.push(`set ${JSON.stringify(s)}`);
      setImmediate(() => cb(null));
    }
    write(d: Uint8Array, cb?: (e: Error | null | undefined) => void) {
      log.writes.push([...d]);
      log.events.push("write");
      setImmediate(() => cb?.(null));
      return true;
    }
    drain(cb: (e: Error | null) => void) {
      if (!o.hangDrain) setImmediate(() => cb(null));
    }
    close(cb: (e: Error | null) => void) {
      log.closed = true;
      setImmediate(() => cb(null));
    }
  }
  return { log, ctor: Mock as unknown as SerialPortCtor };
}

describe("serial RTS/DTR PTT", () => {
  it("opens with HUPCL, drives the line unkeyed at open, then asserts and drops it", async () => {
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec("serial:/dev/ttyUSB0:rts"), { loadSerialPort: async () => m.ctor });
    await ptt.key();
    await ptt.unkey();
    await ptt.close();
    expect(m.log.path).toBe("/dev/ttyUSB0");
    // HUPCL: the kernel drops RTS and DTR when the descriptor closes, at exit or a crash
    expect(m.log.hupcl).toBe(true);
    expect(m.log.events.slice(0, 2)).toEqual(["open", 'set {"rts":false}']);
    expect(m.log.sets).toEqual([{ rts: false }, { rts: true }, { rts: false }, { rts: false }]);
    expect(m.log.closed).toBe(true);
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
  it("drops RTS and DTR at open, then writes the rig family's unkey, key and unkey at its baud rate", async () => {
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec("cat:/dev/ttyUSB1:icom:19200:0x94"), { loadSerialPort: async () => m.ctor });
    await ptt.key();
    await ptt.unkey();
    expect(m.log.baudRate).toBe(19200);
    // a CAT cable that keys on RTS or DTR is not keyed by the open
    expect(m.log.events.slice(0, 3)).toEqual(["open", 'set {"rts":false,"dtr":false}', "write"]);
    const hex = m.log.writes.map((w) => w.map((b) => b.toString(16).padStart(2, "0")).join(" "));
    expect(hex).toEqual(["fe fe 94 e0 1c 00 00 fd", "fe fe 94 e0 1c 00 01 fd", "fe fe 94 e0 1c 00 00 fd"]);
  });

  it("a port that never drains fails the command within its timeout instead of hanging", async () => {
    const m = serialMock({ hangDrain: true });
    const t0 = Date.now();
    await expect(
      openPtt(parsePttSpec("cat:/dev/ttyUSB1:kenwood"), { loadSerialPort: async () => m.ctor }),
    ).rejects.toThrow(/did not answer within 2000 ms/);
    expect(Date.now() - t0).toBeLessThan(3500);
  });

  it("unkeys synchronously by writing to the device on exit", async () => {
    const dev = path.join(tmpDir(), "ttyUSB1");
    fs.writeFileSync(dev, "");
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec(`cat:${dev}:kenwood`), { loadSerialPort: async () => m.ctor });
    ptt.releaseSync!();
    expect(fs.readFileSync(dev, "utf8")).toBe("RX;");
  });

  it("after a clean close the exit release leaves the tty alone (no RTS/DTR blip)", async () => {
    const dev = path.join(tmpDir(), "ttyUSB2");
    fs.writeFileSync(dev, "");
    const m = serialMock();
    const ptt = await openPtt(parsePttSpec(`cat:${dev}:kenwood`), { loadSerialPort: async () => m.ctor });
    await ptt.close();
    ptt.releaseSync!();
    expect(fs.readFileSync(dev, "utf8")).toBe("");
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

  it("never creates a missing device file, and names the udev fix when it is not writable", () => {
    const missing = path.join(tmpDir(), "hidraw9");
    expect(() => openCm108Ptt({ path: missing, gpio: 3 })).toThrow(/cannot open/);
    expect(fs.existsSync(missing)).toBe(false);
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

describe("GPIO PTT (gpioset)", () => {
  const gpio = (g: ReturnType<typeof gpiosetSpy>, invert = false) =>
    openGpioPtt({ chip: "gpiochip0", line: 17, invert }, { spawn: g.spawn, spawnSync: g.spawnSync, settleMs: 1 });

  it("holds the line with libgpiod 2's arguments, ending each holder before the next takes the line", async () => {
    const g = gpiosetSpy("v2.1.1");
    const ptt = await gpio(g);
    await ptt.key();
    await ptt.unkey();
    expect(g.calls).toEqual([
      ["-c", "gpiochip0", "17=0"],
      ["-c", "gpiochip0", "17=1"],
      ["-c", "gpiochip0", "17=0"],
    ]);
    expect(g.log).toEqual(["hold 0", "kill 0 SIGTERM", "hold 1", "kill 1 SIGTERM", "hold 0"]);
    ptt.releaseSync!();
    expect(g.kids[2]!.killedWith).toBe("SIGKILL");
    expect(g.once).toEqual([["-t0", "-c", "gpiochip0", "17=0"]]);
    expect(g.level()).toBe("0");
  });

  it("uses libgpiod 1's signal mode, and inverts an active-low line", async () => {
    const g = gpiosetSpy("v1.6.3");
    const ptt = await gpio(g, true);
    await ptt.key();
    expect(g.calls).toEqual([
      ["--mode=signal", "gpiochip0", "17=1"],
      ["--mode=signal", "gpiochip0", "17=0"],
    ]);
    expect(gpiosetHoldArgs(1, "gpiochip0", 5, 1)).toEqual(["--mode=signal", "gpiochip0", "5=1"]);
  });

  it("serializes key, unkey and close: no keyed holder is left after a close that raced a key", async () => {
    const g = gpiosetSpy("v2.1");
    const ptt = await gpio(g);
    const k = ptt.key();
    const c = ptt.close();
    const u = ptt.key().catch((e: Error) => e.message); // after the close: refused
    await Promise.all([k, c]);
    expect(await u).toMatch(/closed/);
    expect(g.live()).toHaveLength(0);
    expect(g.level()).toBe("0");
    expect(g.log.at(-1)).toBe("once 0");
  });

  it("retries a holder while the line is still busy with the one that is exiting", async () => {
    const g = gpiosetSpy("v2.1", { holdBusy: 2 });
    const ptt = await gpio(g);
    expect(g.calls).toHaveLength(3);
    expect(g.level()).toBe("0");
    await ptt.close();
  });

  it("the exit release retries the one-shot while the killed holder still holds the line", async () => {
    const g = gpiosetSpy("v2.1", { onceBusy: 2 });
    const ptt = await gpio(g);
    await ptt.key();
    ptt.releaseSync!();
    expect(g.log.slice(-4)).toEqual(["kill 1 SIGKILL", "once busy", "once busy", "once 0"]);
  });

  it("checks the one-shot's exit status: a failed one fails the close", async () => {
    const g = gpiosetSpy("v2.1", { onceFails: true });
    const ptt = await gpio(g);
    await expect(ptt.close()).rejects.toThrow(/could not set gpiochip0 line 17 unkeyed/);
  });

  it("rejects when gpioset exits at once with another error (a wrong chip)", async () => {
    const spawn = () => {
      const k = Object.assign(new EventEmitter(), {
        exitCode: null,
        stderr: new EventEmitter(),
        kill: () => true,
      }) as unknown as EventEmitter & GpioChild;
      setImmediate(() => {
        k.emit("spawn");
        (k.stderr as unknown as EventEmitter).emit("data", Buffer.from("gpioset: cannot find GPIO chip"));
        k.emit("exit", 1);
      });
      return k;
    };
    const spawnSync = () => ({ status: 0, stdout: "v2.1" });
    await expect(
      openGpioPtt({ chip: "gpiochip9", line: 17, invert: false }, { spawn, spawnSync, settleMs: 20 }),
    ).rejects.toThrow(/cannot find GPIO chip/);
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
  async function fakeRigctld(reply: (line: string, sock: net.Socket) => string | null) {
    const lines: string[] = [];
    const conns: net.Socket[] = [];
    const server = net.createServer((sock) => {
      conns.push(sock);
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => {
        for (const l of d.split("\n").filter(Boolean)) {
          lines.push(l);
          const r = reply(l, sock);
          if (r !== null) sock.write(r);
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => {
      for (const c of conns) c.destroy();
      server.close();
    });
    return { port: (server.address() as net.AddressInfo).port, lines, conns };
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

  it("a late reply never answers the next command: the timed-out connection is dropped and opened again", async () => {
    let n = 0;
    const d = await fakeRigctld((_l, sock) => {
      n++;
      if (n === 2) {
        // the key's answer comes late, after the box gave up on it
        setTimeout(() => !sock.destroyed && sock.write("RPRT 0\n"), 300);
        return null;
      }
      return n === 3 ? "RPRT -1\n" : "RPRT 0\n";
    });
    const ptt = await openRigctldPtt({ host: "127.0.0.1", port: d.port }, { replyMs: 150 });
    await expect(ptt.key()).rejects.toThrow(/did not answer/);
    // the unkey goes out on a new connection; its own answer (RPRT -1) is the one it gets, not the late RPRT 0
    await expect(ptt.unkey()).rejects.toThrow(/RPRT -1/);
    expect(d.conns).toHaveLength(2);
    await ptt.unkey();
    await ptt.close();
  });

  it("reconnects after rigctld drops the connection", async () => {
    const d = await fakeRigctld(() => "RPRT 0\n");
    const ptt = await openRigctldPtt({ host: "127.0.0.1", port: d.port });
    d.conns[0]!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await ptt.key();
    await ptt.unkey();
    expect(d.conns).toHaveLength(2);
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

  it("stays armed until an unkey is confirmed: a failed unkey trips at once and retries", async () => {
    const inner = recordingPtt();
    let failures = 2;
    inner.unkey = async () => {
      inner.events.push("unkey");
      if (failures-- > 0) throw new Error("port gone");
    };
    const faults: string[] = [];
    const w = new PttWatchdog(inner, { maxKeyMs: 60_000, onFault: (r) => faults.push(r) });
    await w.key();
    await expect(w.unkey()).rejects.toThrow("port gone");
    expect(faults[0]).toMatch(/the unkey failed: port gone/);
    // the synchronous release, then unkeys until one is confirmed
    expect(inner.events).toEqual(["key", "unkey", "releaseSync", "unkey", "unkey"]);
    expect(w.isKeyed).toBe(false);
  });

  it("bounds every driver call: a key that never answers trips the watchdog", async () => {
    const inner = recordingPtt();
    inner.key = () => new Promise<void>(() => {}); // hangs
    const faults: string[] = [];
    let unkeyHangs = true;
    inner.unkey = async () => {
      inner.events.push("unkey");
      if (unkeyHangs) {
        unkeyHangs = false;
        await new Promise(() => {});
      }
    };
    const w = new PttWatchdog(inner, { maxKeyMs: 60_000, opTimeoutMs: 50, onFault: (r) => faults.push(r) });
    await expect(w.key()).rejects.toThrow(/key did not answer within 50 ms/);
    expect(faults[0]).toMatch(/keying failed .* the unkey after it failed: .*unkey did not answer/);
    expect(inner.events).toEqual(["unkey", "releaseSync", "unkey"]);
    expect(w.isKeyed).toBe(false);
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
  const track = (...ps: Ptt[]) => {
    for (const p of ps) trackPtt(p);
    cleanups.push(() => ps.forEach(forgetPtt));
  };

  it("unkeys every open PTT on SIGTERM, SIGINT and an uncaught exception, and synchronously on exit", async () => {
    const proc = new EventEmitter();
    installPttRelease(proc as unknown as NodeJS.Process);
    installPttRelease(proc as unknown as NodeJS.Process); // once per process
    const a = recordingPtt();
    const b = recordingPtt();
    track(a, b);
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
  });

  it("the exit release covers a PTT whose close already resolved, and one whose close never did", () => {
    const proc = new EventEmitter();
    installPttRelease(proc as unknown as NodeJS.Process);
    const closed = recordingPtt();
    const stuck = recordingPtt();
    track(closed, stuck);
    untrackPtt(closed); // its close resolved: no unkey on a signal
    proc.emit("SIGTERM");
    expect(closed.events).toEqual([]);
    proc.emit("exit");
    expect(closed.events).toEqual(["releaseSync"]);
    expect(stuck.events).toEqual(["unkey", "releaseSync"]);
  });
});
