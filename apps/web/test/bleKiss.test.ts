// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type Ax25Frame } from "@aprscaching/ax25";
import { kissWrap } from "@aprscaching/aprs";
import {
  BLE_KISS_API,
  NORDIC_UART,
  BleKissLink,
  bleChunks,
  bleKissRequestOptions,
  bleWriteMode,
  pickBleKissProfile,
  viewBytes,
} from "../src/rf/bleKiss.js";
import { ax25Feeder } from "../src/packet/serialKiss.js";
import { BleKissTransport } from "../src/packet/bleKiss.js";

const frame = (text: string): Ax25Frame => ({
  dst: { call: "OE8XBM", ssid: 7 },
  src: { call: "OE8APR", ssid: 1 },
  command: true,
  type: "I",
  pf: false,
  nr: 2,
  ns: 3,
  pid: 0xf0,
  info: new TextEncoder().encode(text),
});
const textOf = (f: Ax25Frame) => new TextDecoder().decode(f.info);

describe("the BLE KISS services", () => {
  it("asks the chooser for a device offering either service, and keeps both reachable", () => {
    const o = bleKissRequestOptions();
    expect(o.filters).toEqual([{ services: [BLE_KISS_API.service] }, { services: [NORDIC_UART.service] }]);
    expect(o.optionalServices).toEqual([BLE_KISS_API.service, NORDIC_UART.service]);
  });

  it("carries the BLE KISS API UUIDs Mobilinkd publishes", () => {
    expect(BLE_KISS_API).toMatchObject({
      service: "00000001-ba2a-46c9-ae49-01b0961f68bb",
      notify: "00000003-ba2a-46c9-ae49-01b0961f68bb",
      write: "00000002-ba2a-46c9-ae49-01b0961f68bb",
    });
  });

  it("picks whichever service the device offers, in any case", () => {
    expect(pickBleKissProfile([NORDIC_UART.service])).toBe(NORDIC_UART);
    expect(pickBleKissProfile([BLE_KISS_API.service.toUpperCase()])).toBe(BLE_KISS_API);
    expect(pickBleKissProfile(["0000180f-0000-1000-8000-00805f9b34fb"])).toBeNull();
  });

  it("prefers the BLE KISS API when a device offers both", () => {
    expect(pickBleKissProfile([NORDIC_UART.service, BLE_KISS_API.service])).toBe(BLE_KISS_API);
  });
});

describe("BLE writes", () => {
  it("splits bytes into 20-byte pieces, in order, with nothing lost", () => {
    const bytes = Uint8Array.from({ length: 47 }, (_, i) => i);
    const pieces = bleChunks(bytes);
    expect(pieces.map((p) => p.length)).toEqual([20, 20, 7]);
    expect(Uint8Array.from(pieces.flatMap((p) => [...p]))).toEqual(bytes);
    expect(bleChunks(new Uint8Array(0))).toEqual([]);
  });

  it("writes without a response only when the characteristic allows it", () => {
    expect(bleWriteMode({ writeWithoutResponse: true, write: true })).toBe("without-response");
    expect(bleWriteMode({ write: true })).toBe("with-response");
    expect(bleWriteMode(undefined)).toBe("with-response");
  });

  it("reads only a notification's own window of a shared buffer", () => {
    const buf = Uint8Array.from([9, 9, 1, 2, 3, 9]).buffer;
    expect([...viewBytes(new DataView(buf, 2, 3))]).toEqual([1, 2, 3]);
  });
});

describe("reassembly across notifications", () => {
  it("delivers a frame split over 20-byte notifications once, whole", () => {
    const got: Ax25Frame[] = [];
    const feed = ax25Feeder((f) => got.push(f));
    const wire = kissWrap(encodeFrame(frame("a line long enough to span several BLE notifications")));
    for (const piece of bleChunks(wire)) {
      feed(piece);
    }
    expect(got).toHaveLength(1);
    expect(textOf(got[0]!)).toBe("a line long enough to span several BLE notifications");
    expect(got[0]!.src).toEqual({ call: "OE8APR", ssid: 1 });
  });

  it("splits two frames sharing one notification, and skips KISS commands", () => {
    const got: string[] = [];
    const feed = ax25Feeder((f) => got.push(textOf(f)));
    const command = Uint8Array.from([0xc0, 0x06, 0x01, 0xc0]); // a SetHardware frame a TNC3 may send
    const a = kissWrap(encodeFrame(frame("one")));
    const b = kissWrap(encodeFrame(frame("two")));
    feed(Uint8Array.from([...a, ...command, ...b.subarray(0, 5)]));
    feed(b.subarray(5));
    expect(got).toEqual(["one", "two"]);
  });
});

/**
 * A fake Bluetooth TNC: one service, a notify and a write characteristic, writes recorded. Its GATT connection
 * is tracked, and dropping it fires gattserverdisconnected the way Chromium does.
 */
function fakeTnc(service: string, opts: { slowWrites?: boolean; notifyFails?: boolean } = {}) {
  const profile = service === BLE_KISS_API.service ? BLE_KISS_API : NORDIC_UART;
  const writes: number[][] = [];
  let listener: ((e: Event) => void) | null = null;
  const notifyChar = {
    startNotifications: async () => {
      if (opts.notifyFails) throw new Error("GATT operation failed");
    },
    stopNotifications: async () => {},
    addEventListener: (_t: string, fn: (e: Event) => void) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  const writeChar = {
    properties: { writeWithoutResponse: true },
    startNotifications: async () => {},
    stopNotifications: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    writeValueWithoutResponse: async (d: Uint8Array) => {
      if (opts.slowWrites) await new Promise((r) => setTimeout(r, 1));
      writes.push([...d]);
    },
  };
  const svc = {
    uuid: service,
    getCharacteristic: async (u: string) => {
      if (u === profile.notify) return notifyChar;
      if (u === profile.write) return writeChar;
      throw new Error("no such characteristic");
    },
  };
  const gattState = { connected: false };
  let onDrop: (() => void) | null = null;
  const requestDevice = vi.fn(async () => ({
    gatt: {
      connect: async () => {
        gattState.connected = true;
        return { getPrimaryServices: async () => [svc] };
      },
      disconnect: () => {
        if (!gattState.connected) return;
        gattState.connected = false;
        onDrop?.();
      },
    },
    addEventListener: (_t: string, fn: () => void) => (onDrop = fn),
  }));
  vi.stubGlobal("navigator", { bluetooth: { requestDevice } });
  const drop = () => {
    gattState.connected = false;
    onDrop?.();
  };
  const notify = (bytes: Uint8Array) => {
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    listener?.({ target: { value: new DataView(padded.buffer, 2, bytes.length) } } as unknown as Event);
  };
  return { writes, notify, requestDevice, gattState, drop };
}

describe("BleKissLink", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("connects over the BLE KISS API service and reassembles its notifications", async () => {
    const tnc = fakeTnc(BLE_KISS_API.service);
    const got: string[] = [];
    const link = new BleKissLink(ax25Feeder((f) => got.push(textOf(f))));
    await link.connect();
    expect(tnc.requestDevice).toHaveBeenCalledWith(bleKissRequestOptions());
    expect(link.profile).toBe(BLE_KISS_API);
    for (const piece of bleChunks(kissWrap(encodeFrame(frame("heard over Bluetooth, in pieces"))))) tnc.notify(piece);
    expect(got).toEqual(["heard over Bluetooth, in pieces"]);
  });

  it("falls back to the Nordic UART Service", async () => {
    fakeTnc(NORDIC_UART.service);
    const link = new BleKissLink(() => {});
    await link.connect();
    expect(link.profile).toBe(NORDIC_UART);
    expect(link.writable).toBe(true);
  });

  it("queues writes so the pieces of two frames never interleave", async () => {
    const tnc = fakeTnc(BLE_KISS_API.service, { slowWrites: true });
    const link = new BleKissLink(() => {});
    await link.connect();
    const a = Uint8Array.from({ length: 30 }, () => 0xaa);
    const b = Uint8Array.from({ length: 30 }, () => 0xbb);
    await Promise.all([link.write(a), link.write(b)]);
    expect(tnc.writes.map((w) => [w.length, w[0]])).toEqual([
      [20, 0xaa],
      [10, 0xaa],
      [20, 0xbb],
      [10, 0xbb],
    ]);
  });

  it("refuses a device that offers no KISS service, and that error is the only report", async () => {
    const tnc = fakeTnc("0000180f-0000-1000-8000-00805f9b34fb");
    const onLost = vi.fn();
    await expect(new BleKissLink(() => {}, onLost).connect()).rejects.toThrow(/no KISS service/);
    expect(tnc.gattState.connected).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("releases the GATT connection when setting up notifications fails", async () => {
    const tnc = fakeTnc(BLE_KISS_API.service, { notifyFails: true });
    const onLost = vi.fn();
    await expect(new BleKissLink(() => {}, onLost).connect()).rejects.toThrow(/GATT operation failed/);
    expect(tnc.gattState.connected).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("packet terminal: a refused device shows its own error, not a disconnect", async () => {
    fakeTnc("0000180f-0000-1000-8000-00805f9b34fb");
    const onClose = vi.fn();
    await expect(new BleKissTransport(() => {}, onClose).connect()).rejects.toThrow(/no KISS service/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a TNC that drops an established link, and not one the operator disconnects", async () => {
    const tnc = fakeTnc(BLE_KISS_API.service);
    const onLost = vi.fn();
    const link = new BleKissLink(() => {}, onLost);
    await link.connect();
    tnc.drop();
    expect(onLost).toHaveBeenCalledTimes(1);

    const again = fakeTnc(BLE_KISS_API.service);
    const quiet = vi.fn();
    const mine = new BleKissLink(() => {}, quiet);
    await mine.connect();
    await mine.disconnect();
    expect(again.gattState.connected).toBe(false);
    expect(quiet).not.toHaveBeenCalled();
  });
});
