// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT as a CAT command over the radio's serial port, for the families the CAT codec speaks
 * (`packages/aprs/src/cat.ts`): Kenwood and modern Yaesu ASCII (`TX;` / `RX;`), Icom CI-V (`1C 00`) and
 * classic Yaesu binary (FT-817/857/897). A radio does not unkey when its CAT port closes, so process exit
 * writes the unkey command straight to the device; set the radio's own transmit time-out as well.
 *
 * Many CAT cables also key the radio on RTS or DTR, and the kernel asserts both when the port opens, so the
 * driver drops both in the open callback and keeps them dropped. Every command waits at most two seconds for
 * the port to take it.
 */
import fs from "node:fs";
import { catSetPtt } from "@aprscaching/aprs";
import type { Ptt } from "./types.js";
import { closeSerial, openSerial, type SerialPortCtor } from "./serialport.js";
import { withTimeout } from "./watchdog.js";

export async function openCatPtt(
  o: { path: string; rig: "kenwood" | "icom" | "yaesu-bin"; baud: number; icomAddr?: number },
  ctor: SerialPortCtor,
  fsx: Pick<typeof fs, "openSync" | "writeSync" | "closeSync"> = fs,
): Promise<Ptt> {
  const port = await openSerial(ctor, o.path, o.baud, "ptt");
  const bytes = (on: boolean) => catSetPtt(o.rig, on, { icomAddr: o.icomAddr });
  const send = (on: boolean) =>
    withTimeout(
      new Promise<void>((res, rej) => {
        port.write(bytes(on), (e) => {
          if (e) return rej(e);
          port.drain((d) => (d ? rej(d) : res()));
        });
      }),
      2000,
      `CAT ${o.path}`,
    );
  await withTimeout(
    new Promise<void>((res, rej) => port.set({ rts: false, dtr: false }, (e) => (e ? rej(e) : res()))),
    2000,
    `CAT ${o.path} RTS/DTR`,
  );
  await send(false);
  return {
    label: `CAT ${o.rig} ${o.path} ${o.baud} Bd`,
    key: () => send(true),
    unkey: () => send(false),
    close: async () => {
      await send(false).catch(() => {});
      await closeSerial(port);
    },
    // the port keeps the line settings serialport gave it, so a plain write reaches the radio; non-blocking, so
    // a tty waiting for carrier never stalls the exit or the watchdog
    releaseSync: () => {
      const fd = fsx.openSync(o.path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
      try {
        fsx.writeSync(fd, bytes(false));
      } finally {
        fsx.closeSync(fd);
      }
    },
  };
}
