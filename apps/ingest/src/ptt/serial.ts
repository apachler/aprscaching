// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT on a serial control line: RTS or DTR asserted keys the radio, through a transistor or the keying
 * input of an interface such as a SignaLink-style or home-built cable.
 *
 * The kernel asserts RTS and DTR when a program opens the port, so the driver drops the PTT line in the open
 * callback, a few milliseconds later; an interface that cannot take that blip wants another PTT. The port is
 * opened with HUPCL, so the kernel drops both lines when the last descriptor closes: at a clean stop, and when
 * the process ends any other way, a crash or SIGKILL included. That is the release on exit, done by the
 * kernel; there is no synchronous path in Node to set a modem line. An inverted line (keyed when dropped)
 * would key the radio whenever nothing holds the port, so the parser refuses it.
 */
import type { Ptt } from "./types.js";
import { closeSerial, openSerial, type SerialPortCtor } from "./serialport.js";
import { withTimeout } from "./watchdog.js";

export async function openSerialPtt(o: { path: string; line: "rts" | "dtr" }, ctor: SerialPortCtor): Promise<Ptt> {
  const port = await openSerial(ctor, o.path, 9600, "ptt");
  const set = (on: boolean) =>
    withTimeout(
      new Promise<void>((res, rej) => {
        port.set(o.line === "rts" ? { rts: on } : { dtr: on }, (e) => (e ? rej(e) : res()));
      }),
      2000,
      `serial ${o.path} ${o.line.toUpperCase()}`,
    );
  await set(false);
  return {
    label: `serial ${o.path} ${o.line.toUpperCase()}`,
    key: () => set(true),
    unkey: () => set(false),
    close: async () => {
      await set(false).catch(() => {});
      await closeSerial(port);
    },
  };
}
