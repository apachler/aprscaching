// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT on a GPIO pin of a CM108/CM119 USB sound chip (most USB soundcard interfaces built for packet, and the
 * AllStar-style boards), set with a HID output report written to its `/dev/hidraw*` device. The report is
 * five bytes: report id 0, then 0, the pin mask, the pin state and 0, the same as Direwolf writes. The pins
 * count from 1; GPIO3 is the one most interfaces wire to PTT. A plain file write needs no native addon, and it
 * is synchronous, so process exit unkeys the radio too.
 */
import fs from "node:fs";
import type { Ptt } from "./types.js";

type FsLike = Pick<typeof fs, "openSync" | "writeSync" | "closeSync">;

/** The HID output report that sets `gpio` (1–8) to `on`. */
export function cm108Report(gpio: number, on: boolean): Uint8Array {
  const mask = 1 << (gpio - 1);
  return Uint8Array.from([0, 0, mask, on ? mask : 0, 0]);
}

export function openCm108Ptt(o: { path: string; gpio: number }, fsx: FsLike = fs): Ptt {
  let fd: number;
  try {
    // write-only and never created: a missing device must not leave a plain file in its place
    fd = fsx.openSync(o.path, fs.constants.O_WRONLY);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      err.code === "EACCES"
        ? `no write access to ${o.path}: give the ingest's user access with a udev rule (see the soundcard page)`
        : `cannot open ${o.path}: ${err.message}`,
      { cause: e },
    );
  }
  let open = true;
  const write = (on: boolean) => {
    if (!open) throw new Error(`${o.path} is closed`);
    fsx.writeSync(fd, cm108Report(o.gpio, on));
  };
  write(false);
  return {
    label: `CM108 ${o.path} GPIO${o.gpio}`,
    key: async () => write(true),
    unkey: async () => write(false),
    close: async () => {
      if (!open) return;
      try {
        write(false);
      } finally {
        open = false;
        fsx.closeSync(fd);
      }
    },
    releaseSync: () => {
      if (open) write(false);
    },
  };
}
