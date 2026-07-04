// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * simSerial.ts — a fake `navigator.serial` for the design harness, so the Web-Serial-only surfaces
 * (CAT rig control) render their CONNECTED state with no hardware. The fake port accepts
 * `open()`/`close()` and exposes a `writable` that sinks CAT frames (we don't decode them — the point
 * is to screenshot the working tune UI). Chromium-gated in production; this only runs under `?demo=`.
 */
interface FakePort {
  writable: WritableStream<Uint8Array>;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

function makeFakePort(): FakePort {
  const writable = new WritableStream<Uint8Array>({
    write() {
      /* sink the CAT bytes */
    },
  });
  return {
    writable,
    async open() {
      /* no-op: the fake port is always "open" */
    },
    async close() {
      /* no-op */
    },
  };
}

/** Install a fake `navigator.serial`. Idempotent. Only used by the harness; never shipped behind `?demo=`. */
export function installSerialSim(): void {
  const nav = navigator as unknown as { serial?: unknown };
  if ((nav.serial as { __sim?: boolean } | undefined)?.__sim) return;
  const serial = {
    __sim: true,
    async requestPort(): Promise<FakePort> {
      return makeFakePort();
    },
    async getPorts(): Promise<FakePort[]> {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  // navigator.serial is a getter-only accessor in real Chromium — defineProperty overrides it.
  Object.defineProperty(navigator, "serial", { configurable: true, value: serial });
}
