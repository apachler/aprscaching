// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ax25Frame } from "@aprscaching/ax25";
import { SerialKissTransport } from "../src/packet/serialKiss.js";
import { WebSerialKiss } from "../src/rf/kiss.js";
import { WebSerialMeshtastic } from "../src/rf/extralinks.js";

/**
 * A fake Web Serial port that refuses a second open, as Chromium does. While open it offers a fresh readable each
 * time it is asked, and every read on it fails, so a reader that keeps going after a failure shows up as more reads.
 */
function fakePort() {
  const state = { open: false, opens: 0, closes: 0, reads: 0 };
  const port = {
    get readable(): ReadableStream<Uint8Array> | null {
      if (!state.open) return null;
      return new ReadableStream<Uint8Array>(
        {
          pull(c) {
            state.reads++;
            c.error(new Error("the device has been lost"));
          },
        },
        { highWaterMark: 0 },
      ); // pull only on a read, not to prefill
    },
    get writable(): WritableStream<Uint8Array> | null {
      return state.open ? new WritableStream<Uint8Array>() : null;
    },
    async open() {
      if (state.open) throw new Error("port is already open");
      state.open = true;
      state.opens++;
    },
    async close() {
      state.open = false;
      state.closes++;
    },
  };
  vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });
  return state;
}

/** Resolves on the link's first onClose report, with its error. */
function lostReport() {
  let report!: (e?: Error) => void;
  const lost = new Promise<Error | undefined>((r) => (report = r));
  const onClose = vi.fn((e?: Error) => report(e));
  return { lost, onClose };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("a serial link that fails while reading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("packet terminal: closes the port before reporting the loss, so the TNC opens again", async () => {
    const port = fakePort();
    const { lost, onClose } = lostReport();
    const t = new SerialKissTransport(() => {}, onClose);
    await t.connect();
    expect((await lost)?.message).toBe("the device has been lost");
    expect(port.open).toBe(false);
    await t.disconnect(); // the terminal's own teardown after the report
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(new SerialKissTransport(() => {}).connect()).resolves.toBeUndefined();
    expect(port.opens).toBe(2);
  });

  it("My radio: closes the port before reporting the loss, so the radio connects again", async () => {
    const port = fakePort();
    const { lost, onClose } = lostReport();
    const l = new WebSerialKiss(() => {}, onClose);
    await l.connect();
    expect((await lost)?.message).toBe("the device has been lost");
    expect(port.open).toBe(false);
    await expect(new WebSerialKiss(() => {}).connect()).resolves.toBeUndefined();
    expect(port.opens).toBe(2);
  });

  it("Meshtastic: stops reading at the first failure, closes the port and reports the loss once", async () => {
    const port = fakePort();
    const { lost, onClose } = lostReport();
    const l = new WebSerialMeshtastic(() => {}, onClose);
    await l.connect();
    expect((await lost)?.message).toBe("the device has been lost");
    await settle();
    expect(port.reads).toBe(1);
    expect(port.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(new WebSerialMeshtastic(() => {}).connect()).resolves.toBeUndefined();
  });

  it("reports nothing when the operator disconnects", async () => {
    const onClose = vi.fn();
    const t = new SerialKissTransport(() => {}, onClose);
    vi.stubGlobal("navigator", {
      serial: {
        requestPort: async () => ({
          readable: new ReadableStream<Uint8Array>(), // never yields: the read waits until cancelled
          writable: null,
          open: async () => {},
          close: async () => {},
        }),
      },
    });
    await t.connect();
    await t.disconnect();
    await settle();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("KISS timing on a serial link", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A port that keeps the bytes written to it, with a reader that waits until it is cancelled. */
  function writablePort(writable: boolean) {
    const written: number[][] = [];
    const stream = new WritableStream<Uint8Array>({
      async write(chunk) {
        await new Promise((r) => setTimeout(r, 1)); // a slow port: overlapping writes would find the writer locked
        written.push([...chunk]);
      },
    });
    vi.stubGlobal("navigator", {
      serial: {
        requestPort: async () => ({
          readable: new ReadableStream<Uint8Array>(),
          writable: writable ? stream : null,
          open: async () => {},
          close: async () => {},
        }),
      },
    });
    return written;
  }

  it("writes TXDELAY, PERSIST and SLOTTIME, and queues a frame sent at the same moment behind them", async () => {
    const written = writablePort(true);
    const l = new WebSerialKiss(() => {});
    await l.connect();
    await Promise.all([
      l.setTiming({ txDelay: 30, persist: 63, slotTime: 10 }),
      l.send({ src: "OE8APR-7", dst: "APRS", payload: ">hi" }),
    ]);
    expect(written[0]).toEqual([0xc0, 0x01, 30, 0xc0, 0xc0, 0x02, 63, 0xc0, 0xc0, 0x03, 10, 0xc0]);
    expect(written[1]?.slice(0, 2)).toEqual([0xc0, 0x00]); // the data frame follows
    await l.disconnect();
  });

  it("skips the timing on a port with nothing to write to", async () => {
    const written = writablePort(false);
    const l = new WebSerialKiss(() => {});
    await l.connect();
    await expect(l.setTiming({ txDelay: 30, persist: 63, slotTime: 10 })).resolves.toBeUndefined();
    expect(written).toEqual([]);
    await l.disconnect();
  });

  const TIMING = { txDelay: 40, persist: 31, slotTime: 12 };
  const TIMING_BYTES = [0xc0, 0x01, 40, 0xc0, 0xc0, 0x02, 31, 0xc0, 0xc0, 0x03, 12, 0xc0];
  const ui: Ax25Frame = {
    dst: { call: "APRS", ssid: 0 },
    src: { call: "OE8APR", ssid: 7 },
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(">hi"),
  };

  it("packet terminal: sends the timing as the port opens, ahead of the first frame", async () => {
    const written = writablePort(true);
    const t = new SerialKissTransport(() => {}, undefined, TIMING);
    await t.connect();
    t.send(ui);
    t.send(ui);
    await settle();
    expect(written[0]).toEqual(TIMING_BYTES);
    expect(written).toHaveLength(3);
    expect(written.slice(1).map((w) => w.slice(0, 2))).toEqual([
      [0xc0, 0x00],
      [0xc0, 0x00],
    ]);
    await t.disconnect();
  });

  it("packet terminal: sends no timing to a receive-only port, or when none is given", async () => {
    const quiet = writablePort(false);
    const rx = new SerialKissTransport(() => {}, undefined, TIMING);
    await rx.connect();
    expect(quiet).toEqual([]);
    await rx.disconnect();

    const written = writablePort(true);
    const plain = new SerialKissTransport(() => {});
    await plain.connect();
    expect(written).toEqual([]);
    await plain.disconnect();
  });
});
