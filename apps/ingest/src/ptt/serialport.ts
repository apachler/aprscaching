// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The optional `serialport` package, loaded on demand. It stays an optional dependency: a box without it runs
 * every TCP transport and the soundcard port with a PTT that needs no serial line (CM108, GPIO, rigctld, VOX);
 * only the serial RTS/DTR and direct CAT drivers need it.
 */

/** The part of a `serialport` SerialPort the PTT drivers use. */
export interface SerialLike {
  open(cb: (err: Error | null) => void): void;
  set(signals: { rts?: boolean; dtr?: boolean }, cb: (err: Error | null) => void): void;
  write(data: Uint8Array, cb?: (err: Error | null | undefined) => void): boolean;
  drain(cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

export type SerialPortCtor = new (o: {
  path: string;
  baudRate: number;
  autoOpen: boolean;
  /** Drop RTS and DTR when the last descriptor closes (the default; it is what unkeys a serial PTT on exit). */
  hupcl?: boolean;
}) => SerialLike;

/** The SerialPort constructor, or an error that says how to install the package. */
export async function loadSerialPort(): Promise<SerialPortCtor> {
  const name = "serialport"; // non-literal, so tsc does not require the optional package at build time
  let mod: { SerialPort?: SerialPortCtor; default?: { SerialPort?: SerialPortCtor } };
  try {
    mod = (await import(name)) as typeof mod;
  } catch {
    throw new Error(
      "the optional 'serialport' package is not installed (pnpm --filter @aprscaching/ingest add serialport)",
    );
  }
  const ctor = mod.SerialPort ?? mod.default?.SerialPort;
  if (!ctor) throw new Error("the 'serialport' package has no SerialPort export");
  return ctor;
}

/** Open a serial port and settle once it is open; a USB unplug later is logged, never thrown. */
export async function openSerial(
  ctor: SerialPortCtor,
  path: string,
  baudRate: number,
  tag: string,
): Promise<SerialLike> {
  const port = new ctor({ path, baudRate, autoOpen: false, hupcl: true });
  // without an `error` listener a USB unplug emits an unhandled 'error' that would stop the whole ingest
  port.on("error", (e: Error) => console.error("[%s] serial error on %s: %s", tag, path, e.message));
  port.on("close", () => console.warn("[%s] serial port %s closed (radio unplugged?)", tag, path));
  await new Promise<void>((res, rej) =>
    port.open((e) => (e ? rej(new Error(`cannot open ${path}: ${e.message}`)) : res())),
  );
  return port;
}

/** Close a serial port, settling even when it was already closed. */
export const closeSerial = (port: SerialLike): Promise<void> => new Promise<void>((res) => port.close(() => res()));
