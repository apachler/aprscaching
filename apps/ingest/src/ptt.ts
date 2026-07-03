// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ptt.ts — RTS/DTR push-to-talk over a serial port.
 * For the no-TNC / soundcard TX path (pairs H4/H5), the operator keys the radio by asserting a serial
 * control line. We load `serialport` dynamically so it stays an OPTIONAL dependency — without it the
 * box still runs (KISS/AGWPE/hostmode TNCs do their own keying); only soundcard-PTT is unavailable.
 * This is validate-at-deploy: it needs the package, the cable and a real radio.
 */
export interface Ptt {
  key(): Promise<void>;
  unkey(): Promise<void>;
  close(): Promise<void>;
}

export interface PttOpts {
  line?: "rts" | "dtr";
  invert?: boolean;
  baudRate?: number;
}

/** Open serial PTT on `path` (e.g. /dev/ttyUSB0). Returns null if `serialport` isn't installed. */
export async function openSerialPtt(path: string, opts: PttOpts = {}): Promise<Ptt | null> {
  const line = opts.line ?? "rts";
  try {
    const name = "serialport"; // non-literal so tsc doesn't require the optional dep at build time
    const mod = (await import(name)) as {
      SerialPort?: new (o: unknown) => SerialLike;
      default?: { SerialPort?: new (o: unknown) => SerialLike };
    };
    const SerialPort = mod.SerialPort ?? mod.default?.SerialPort;
    if (!SerialPort) throw new Error("SerialPort export not found");
    const port = new SerialPort({ path, baudRate: opts.baudRate ?? 9600, autoOpen: true });
    const set = (on: boolean) =>
      new Promise<void>((res, rej) => {
        const active = opts.invert ? !on : on;
        const signals = line === "rts" ? { rts: active } : { dtr: active };
        port.set(signals, (e: Error | null) => (e ? rej(e) : res()));
      });
    console.log(`[ptt] serial PTT on ${path} via ${line.toUpperCase()}`);
    return {
      key: () => set(true),
      unkey: () => set(false),
      close: () => new Promise<void>((res) => port.close(() => res())),
    };
  } catch (e) {
    console.log(`[ptt] serial PTT unavailable (install 'serialport' for soundcard keying): ${(e as Error).message}`);
    return null;
  }
}

interface SerialLike {
  set(signals: { rts?: boolean; dtr?: boolean }, cb: (err: Error | null) => void): void;
  close(cb: () => void): void;
}
