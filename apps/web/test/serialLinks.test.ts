// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
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
