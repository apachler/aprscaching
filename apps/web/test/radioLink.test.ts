// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { Packet } from "@aprscaching/shared";
import {
  FLUSH_FRAMES,
  RadioLinkStore,
  holdRadio,
  radioBusyText,
  txWord,
  type RadioDeps,
  type RadioEvent,
} from "../src/rf/radioLink.js";
import type { RfFrame } from "../src/rf/kiss.js";

/** A fake radio: it records connects, disconnects and sends, and lets the test deliver frames or lose the device. */
function fakeRadio(opts: { failConnect?: Error } = {}) {
  const r = {
    connects: 0,
    disconnects: 0,
    sent: [] as unknown[],
    frame: (_f: RfFrame) => {},
    lose: (_e?: Error) => {},
  };
  const forwarded: Packet[][] = [];
  const timers: (() => void)[] = [];
  const deps: RadioDeps = {
    makeLink: (_kind, onFrame, onClose) => {
      r.frame = onFrame;
      r.lose = onClose;
      return {
        async connect() {
          if (opts.failConnect) throw opts.failConnect;
          r.connects++;
        },
        async disconnect() {
          r.disconnects++;
        },
        async send(f) {
          r.sent.push(f);
        },
      };
    },
    forward: (packets) => {
      forwarded.push(packets);
      return Promise.resolve();
    },
    feedLocal: () => {},
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  };
  const store = new RadioLinkStore(deps);
  const events: RadioEvent[] = [];
  store.onEvent((e) => events.push(e));
  return { r, store, events, forwarded, timers };
}

const frame = (n: number): RfFrame =>
  ({
    frame: { src: `N0CALL-${n}`, dst: "APRS", path: [], payload: "x", raw: `N0CALL-${n}>APRS:x` },
    data: { kind: "status" },
    packet: { src: `N0CALL-${n}` } as Packet,
    at: n,
  }) as unknown as RfFrame;

describe("the app-wide radio link", () => {
  it("stays connected until an explicit disconnect, and counts what it hears", async () => {
    const { r, store, events } = fakeRadio();
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    expect(store.getState().link).toBe("serial");
    expect(events).toEqual([{ kind: "connected", link: "serial" }]);
    r.frame(frame(1));
    r.frame(frame(2));
    expect(store.getState().count).toBe(2);
    expect(store.getState().frames[0]?.at).toBe(2);
    await store.disconnect();
    expect(store.getState().link).toBeNull();
    expect(r.disconnects).toBe(1);
  });

  it("reports the loss of the device once, and ignores a close after a disconnect", async () => {
    const { r, store, events } = fakeRadio();
    await store.connect("ble");
    r.lose(new Error("the Bluetooth TNC disconnected"));
    expect(store.getState().link).toBeNull();
    expect(events.at(-1)).toEqual({ kind: "lost", message: "the Bluetooth TNC disconnected" });
    r.lose(new Error("again"));
    expect(events.filter((e) => e.kind === "lost")).toHaveLength(1);
  });

  it("stays quiet when the user cancels the device chooser", async () => {
    const { store, events } = fakeRadio({ failConnect: new Error("No port selected by the user.") });
    await store.connect("serial");
    expect(store.getState()).toMatchObject({ link: null, busy: false });
    expect(events).toEqual([]);
  });

  it("ends the link and the forwarding when the account changes, and keeps them across a verification change", async () => {
    const { r, store } = fakeRadio();
    store.setIdentity("OE8APR", false);
    await store.connect("serial");
    store.setForward(true);
    store.setIdentity("OE8APR", true);
    expect(store.getState()).toMatchObject({ link: "serial", fwdOn: true });
    store.setIdentity("", false);
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ link: null, fwdOn: false });
    expect(r.disconnects).toBe(1);
  });

  it("switches transmit off when the verified callsign changes, and allows it only on a verified call", async () => {
    const { r, store } = fakeRadio();
    store.setIdentity("OE8APR", false);
    await store.connect("serial");
    store.setTxOn(true);
    expect(store.getState().txOn).toBe(false);
    await expect(store.transmit({ src: "OE8APR-7", dst: "APRS", payload: "x" })).rejects.toThrow();
    store.setIdentity("OE8APR", true);
    store.setTxOn(true);
    expect(store.canTransmit()).toBe(true);
    await store.transmit({ src: store.txCall(), dst: "APRS", payload: "x" });
    expect(r.sent).toHaveLength(1);
    store.setIdentity("OE8APR", false);
    expect(store.getState().txOn).toBe(false);
  });

  it("forwards in batches: a full batch at once, the rest when the timer fires", async () => {
    const { r, store, forwarded, timers } = fakeRadio();
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    store.setForward(true);
    for (let i = 0; i < FLUSH_FRAMES + 3; i++) r.frame(frame(i));
    expect(forwarded.map((b) => b.length)).toEqual([FLUSH_FRAMES]);
    timers.at(-1)?.();
    expect(forwarded.map((b) => b.length)).toEqual([FLUSH_FRAMES, 3]);
  });

  it("does not forward while forwarding is off, and sends what is queued on disconnect", async () => {
    const { r, store, forwarded } = fakeRadio();
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    r.frame(frame(1));
    expect(forwarded).toEqual([]);
    store.setForward(true);
    r.frame(frame(2));
    await store.disconnect();
    expect(forwarded.map((b) => b.length)).toEqual([1]);
  });

  it("names the transmit state for the chip", () => {
    expect(txWord({ link: "serial", verified: false, txOn: false })).toBe("TX locked");
    expect(txWord({ link: "serial", verified: true, txOn: false })).toBe("RX only");
    expect(txWord({ link: "audio", verified: true, txOn: true })).toBe("RX only");
    expect(txWord({ link: "serial", verified: true, txOn: true })).toBe("TX on");
  });
});

describe("a radio port two parts of the app reach for", () => {
  it("names the RF bridge when it holds the port the packet terminal tries to open", () => {
    holdRadio("bridge", true);
    const busy = Object.assign(new Error("Failed to execute 'open' on 'SerialPort': The port is already open."), {
      name: "InvalidStateError",
    });
    expect(radioBusyText(busy, "terminal")).toMatch(/in use by the RF bridge/);
    holdRadio("bridge", false);
    expect(radioBusyText(busy, "terminal")).toMatch(/another tab or program/);
  });

  it("names the packet terminal the other way round, and passes other errors through", () => {
    holdRadio("terminal", true);
    expect(radioBusyText(new Error("Failed to open serial port."), "bridge")).toMatch(/in use by the packet terminal/);
    expect(radioBusyText(new Error("No port selected by the user."), "bridge")).toBeNull();
    expect(radioBusyText(new Error("baud rate refused"), "bridge")).toBe("baud rate refused");
    holdRadio("terminal", false);
  });

  it("does not hold up the store when a subscriber throws", async () => {
    const { store } = fakeRadio();
    const spy = vi.fn();
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(spy);
    store.setIdentity("oe8apr-5", true);
    store.setSsid("9");
    expect(spy).toHaveBeenCalled();
    expect(store.txCall()).toBe("OE8APR-9");
  });
});
