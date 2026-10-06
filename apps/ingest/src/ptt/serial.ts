// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT on a serial control line: RTS or DTR asserted keys the radio, through a transistor or the keying
 * input of an interface such as a SignaLink-style or home-built cable. `-rts` / `-dtr` inverts it, for an
 * interface that keys on the line going low. Closing the port drops both lines, which unkeys a
 * non-inverted line even when the process ends without a clean stop.
 */
import type { Ptt } from "./types.js";
import { closeSerial, openSerial, type SerialPortCtor } from "./serialport.js";

export async function openSerialPtt(
  o: { path: string; line: "rts" | "dtr"; invert: boolean },
  ctor: SerialPortCtor,
): Promise<Ptt> {
  const port = await openSerial(ctor, o.path, 9600, "ptt");
  const set = (on: boolean) =>
    new Promise<void>((res, rej) => {
      const level = o.invert ? !on : on;
      port.set(o.line === "rts" ? { rts: level } : { dtr: level }, (e) => (e ? rej(e) : res()));
    });
  await set(false); // a freshly opened port may assert the line: drive it to unkeyed at once
  return {
    label: `serial ${o.path} ${o.invert ? "-" : ""}${o.line.toUpperCase()}`,
    key: () => set(true),
    unkey: () => set(false),
    close: async () => {
      await set(false).catch(() => {});
      await closeSerial(port);
    },
  };
}
