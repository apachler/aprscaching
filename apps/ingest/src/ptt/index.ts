// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The PTT drivers behind one interface ({@link Ptt}), chosen per soundcard port by a `SOUNDCARD_PTT` value:
 *
 *   none | vox                        no keying line: the interface keys on audio (VOX)
 *   serial:/dev/ttyUSB0[:rts|:dtr]    a serial control line; `-rts` / `-dtr` keys on the line going low
 *   cat:/dev/ttyUSB0:<rig>[:baud[:civ]]  a CAT command; rig `kenwood`, `icom` (CI-V address, default 0x94) or `yaesu-bin`
 *   rigctld[:host[:port]]             Hamlib rigctld (default 127.0.0.1:4532)
 *   cm108[:/dev/hidraw0[:gpio]]       a CM108/CM119 GPIO pin (default /dev/hidraw0, GPIO3)
 *   gpio:<chip>:<line>                a Linux GPIO line through libgpiod's gpioset; `-<line>` is active low
 *
 * The drivers that need the optional `serialport` package load it only when chosen.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { Ptt, PttSpec } from "./types.js";
import { loadSerialPort, type SerialPortCtor } from "./serialport.js";
import { openSerialPtt } from "./serial.js";
import { openCatPtt } from "./cat.js";
import { openRigctldPtt } from "./rigctld.js";
import { openCm108Ptt } from "./cm108.js";
import { openGpioPtt, gpiosetVersion, type GpioSpawn, type GpioSpawnSync } from "./gpio.js";

export type { Ptt, PttSpec } from "./types.js";

const CAT_BAUD: Record<string, number> = { kenwood: 9600, icom: 19200, "yaesu-bin": 4800 };

/** Parse a `SOUNDCARD_PTT` value; throws with what is wrong. A blank value is `none`. */
export function parsePttSpec(raw: string | undefined): PttSpec {
  const v = (raw ?? "").trim();
  if (!v || /^(none|vox)$/i.test(v)) return { kind: "none" };
  const [kind, ...rest] = v.split(":");
  const bad = (why: string): never => {
    throw new Error(`PTT "${v}": ${why}`);
  };
  const int = (s: string | undefined, what: string, min: number, max: number): number => {
    const n = Number(s);
    if (!s || !Number.isInteger(n) || n < min || n > max) bad(`${what} must be a whole number from ${min} to ${max}`);
    return n;
  };
  switch (kind!.toLowerCase()) {
    case "serial": {
      const [path, lineRaw = "rts"] = rest;
      if (!path) bad("name the serial device, as in serial:/dev/ttyUSB0:rts");
      const m = /^(-?)(rts|dtr)$/i.exec(lineRaw);
      if (!m) bad("the line is rts, dtr, -rts or -dtr");
      return { kind: "serial", path: path!, line: m![2]!.toLowerCase() as "rts" | "dtr", invert: m![1] === "-" };
    }
    case "cat": {
      const [path, rigRaw, baud, civ] = rest;
      if (!path || !rigRaw) bad("name the device and the rig family, as in cat:/dev/ttyUSB0:icom:19200");
      const rig = rigRaw!.toLowerCase();
      if (rig !== "kenwood" && rig !== "icom" && rig !== "yaesu-bin")
        bad("the rig family is kenwood, icom or yaesu-bin");
      const icomAddr = civ ? Number(civ) : undefined;
      if (icomAddr !== undefined && (!Number.isInteger(icomAddr) || icomAddr < 0 || icomAddr > 0xff))
        bad("the CI-V address is a number from 0 to 0xFF, as in 0x94");
      return {
        kind: "cat",
        path: path!,
        rig: rig as "kenwood" | "icom" | "yaesu-bin",
        baud: baud ? int(baud, "the baud rate", 300, 115200) : CAT_BAUD[rig]!,
        ...(icomAddr !== undefined ? { icomAddr } : {}),
      };
    }
    case "rigctld":
      return {
        kind: "rigctld",
        host: rest[0] || "127.0.0.1",
        port: rest[1] ? int(rest[1], "the rigctld port", 1, 65535) : 4532,
      };
    case "cm108":
      return {
        kind: "cm108",
        path: rest[0] || "/dev/hidraw0",
        gpio: rest[1] ? int(rest[1], "the CM108 GPIO", 1, 8) : 3,
      };
    case "gpio": {
      const [chip, lineRaw] = rest;
      if (!chip || !lineRaw) bad("name the chip and the line, as in gpio:gpiochip0:17");
      const invert = lineRaw!.startsWith("-");
      return { kind: "gpio", chip: chip!, line: int(lineRaw!.replace(/^-/, ""), "the GPIO line", 0, 1023), invert };
    }
    default:
      return bad("the driver is none, vox, serial, cat, rigctld, cm108 or gpio");
  }
}

/** A short description of a PTT setting, for logs and the doctor. */
export function describePtt(s: PttSpec): string {
  switch (s.kind) {
    case "none":
      return "none (VOX)";
    case "serial":
      return `serial ${s.path} ${s.invert ? "-" : ""}${s.line.toUpperCase()}`;
    case "cat":
      return `CAT ${s.rig} ${s.path} ${s.baud} Bd`;
    case "rigctld":
      return `rigctld ${s.host}:${s.port}`;
    case "cm108":
      return `CM108 ${s.path} GPIO${s.gpio}`;
    case "gpio":
      return `GPIO ${s.chip} line ${s.line}${s.invert ? " (active low)" : ""}`;
  }
}

export interface PttDeps {
  loadSerialPort?: () => Promise<SerialPortCtor>;
  fs?: Pick<typeof fs, "openSync" | "writeSync" | "closeSync" | "accessSync" | "existsSync">;
  spawn?: GpioSpawn;
  spawnSync?: GpioSpawnSync;
}

/** The driver for `s`, opened and driven to unkeyed; rejects with a message the operator can act on. */
export async function openPtt(s: PttSpec, deps: PttDeps = {}): Promise<Ptt> {
  const serial = deps.loadSerialPort ?? loadSerialPort;
  switch (s.kind) {
    case "none":
      return {
        label: "none (VOX)",
        key: async () => {},
        unkey: async () => {},
        close: async () => {},
      };
    case "serial":
      return openSerialPtt(s, await serial());
    case "cat":
      return openCatPtt(s, await serial(), deps.fs);
    case "rigctld":
      return openRigctldPtt(s);
    case "cm108":
      return openCm108Ptt(s, deps.fs);
    case "gpio":
      return openGpioPtt(s, { spawn: deps.spawn, spawnSync: deps.spawnSync });
  }
}

/**
 * Whether the driver for `s` can work on this machine, checked without keying anything: the package or the
 * tool is there and the device is writable. rigctld is checked by the doctor's TCP probe instead. Returns
 * null when it looks usable, else what is missing.
 */
export async function pttProblem(s: PttSpec, deps: PttDeps = {}): Promise<string | null> {
  const fsx = deps.fs ?? fs;
  const writable = (path: string): string | null => {
    if (!fsx.existsSync(path)) return `${path} does not exist`;
    try {
      fsx.accessSync(path, fs.constants.W_OK);
      return null;
    } catch {
      return `no write access to ${path}`;
    }
  };
  try {
    switch (s.kind) {
      case "none":
      case "rigctld":
        return null;
      case "serial":
      case "cat":
        await (deps.loadSerialPort ?? loadSerialPort)();
        return writable(s.path);
      case "cm108":
        return writable(s.path);
      case "gpio": {
        const chip = s.chip.startsWith("/") ? s.chip : `/dev/${/^\d+$/.test(s.chip) ? `gpiochip${s.chip}` : s.chip}`;
        gpiosetVersion(deps.spawnSync ?? defaultSpawnSync);
        return writable(chip);
      }
    }
  } catch (e) {
    return (e as Error).message;
  }
}

const defaultSpawnSync: GpioSpawnSync = (c, a) => spawnSync(c, a, { encoding: "utf8" });
