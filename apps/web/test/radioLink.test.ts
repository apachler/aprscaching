// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { encodeAx25 } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import {
  FLUSH_FRAMES,
  RadioLinkStore,
  TX_KEPT,
  holdRadio,
  radioBusyText,
  txWord,
  type RadioDeps,
  type ConsentRequest,
  type RadioEvent,
} from "../src/rf/radioLink.js";
import { ANNOUNCE_GAP_MS, TxAnnouncer, aprsSummary, ax25Summary, terminalTxNote } from "../src/rf/txLog.js";
import type { Ax25Frame } from "@aprscaching/ax25";
import type { RfFrame } from "../src/rf/kiss.js";
import type { KissTiming } from "../src/rf/kissTiming.js";

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

describe("KISS timing for the radio link", () => {
  /** Links that log what reaches them: a KISS TNC (serial, ble) takes timing, the others have no setTiming. */
  function timingRadio(opts: { failTiming?: Error; init?: KissTiming } = {}) {
    const log: string[] = [];
    const saved: KissTiming[] = [];
    const deps: RadioDeps = {
      makeLink: (kind) => ({
        async connect() {
          log.push(`connect ${kind}`);
        },
        async disconnect() {},
        async send() {
          log.push("send");
        },
        ...(kind === "serial" || kind === "ble"
          ? {
              async setTiming(t: KissTiming) {
                if (opts.failTiming) throw opts.failTiming;
                log.push(`timing ${t.txDelay}/${t.persist}/${t.slotTime}`);
              },
            }
          : {}),
      }),
      forward: () => Promise.resolve(),
      feedLocal: () => {},
      saveKissTiming: (t) => saved.push(t),
    };
    const store = new RadioLinkStore(deps, { kissTiming: opts.init });
    const events: RadioEvent[] = [];
    store.onEvent((e) => events.push(e));
    return { store, log, saved, events };
  }

  it("sends the APRS defaults to a KISS TNC as it connects, before the link reports connected", async () => {
    for (const kind of ["serial", "ble"] as const) {
      const { store, log, events } = timingRadio();
      store.onEvent((e) => e.kind === "connected" && log.push("connected"));
      await store.connect(kind);
      expect(log).toEqual([`connect ${kind}`, "timing 30/63/10", "connected"]);
      expect(events.map((e) => e.kind)).toEqual(["connected"]);
    }
  });

  it("sends nothing to the soundcard modem or a Meshtastic node", async () => {
    for (const kind of ["audio", "mesh"] as const) {
      const { store, log } = timingRadio();
      await store.connect(kind);
      store.setKissTiming({ txDelay: 40 });
      expect(log).toEqual([`connect ${kind}`]);
    }
  });

  it("starts from the stored settings", async () => {
    const { store, log } = timingRadio({ init: { txDelay: 50, persist: 127, slotTime: 20 } });
    await store.connect("serial");
    expect(log).toContain("timing 50/127/20");
  });

  it("saves a change, sends it to a connected TNC at once, and ignores a value outside 0–255", async () => {
    const { store, log, saved } = timingRadio();
    store.setKissTiming({ txDelay: 45 }); // no link yet: saved, sent on the next connect
    expect(saved).toEqual([{ txDelay: 45, persist: 63, slotTime: 10 }]);
    await store.connect("serial");
    store.setKissTiming({ persist: 255, slotTime: 300 });
    store.setKissTiming({ slotTime: 1.5, txDelay: -1 });
    store.setKissTiming({ persist: 255 }); // no change: nothing saved or sent
    await Promise.resolve();
    expect(store.getState().kissTiming).toEqual({ txDelay: 45, persist: 255, slotTime: 10 });
    expect(saved).toHaveLength(2);
    expect(log).toEqual(["connect serial", "timing 45/63/10", "timing 45/255/10"]);
  });

  it("reports a TNC that refuses its timing and keeps the link up", async () => {
    const { store, events } = timingRadio({ failTiming: new Error("write failed") });
    await store.connect("serial");
    expect(store.getState().link).toBe("serial");
    expect(events).toEqual([
      { kind: "timing-failed", message: "write failed" },
      { kind: "connected", link: "serial" },
    ]);
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

/** A store with a consent dialog the test answers: each ask is recorded and resolves with `answer`. */
function consenting(answer: boolean | (() => Promise<boolean>) = true) {
  const t = fakeRadio();
  const asked: ConsentRequest[] = [];
  t.store.setConsentAsker((req) => {
    asked.push(req);
    return typeof answer === "function" ? answer() : Promise.resolve(answer);
  });
  return { ...t, asked };
}
const settle = () => new Promise((res) => setTimeout(res, 0));
const msgFrame = (src: string, n = 1) => ({ src, dst: "APRS", path: ["WIDE1-1"], payload: `:OE8XBM   :hi{${n}` });

describe("transmit consent for one browser session", () => {
  it("asks once as a transmit-capable radio connects under a verified callsign, and transmits after Allow", async () => {
    const { r, store, asked } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    expect(asked).toEqual([{ who: "bridge", call: "OE8APR-7", via: "your USB radio" }]);
    expect(store.getState().txOn).toBe(true);
    await store.transmit(msgFrame(store.txCall()), "My radio");
    expect(r.sent).toHaveLength(1);
  });

  it("never transmits without a grant: Receive only keeps receiving and sends nothing", async () => {
    const { r, store, asked } = consenting(false);
    store.setIdentity("OE8APR", true);
    await store.connect("ble");
    await settle();
    expect(store.getState().txOn).toBe(false);
    r.frame(frame(1));
    expect(store.getState().count).toBe(1);
    // the first transmit attempt asks again; a refusal sends nothing
    await expect(store.transmit(msgFrame("OE8APR-7"), "Messages")).rejects.toThrow(/consent/);
    expect(asked).toHaveLength(2);
    expect(r.sent).toEqual([]);
    expect(store.getState().sent).toEqual([]);
  });

  it("does not ask, or allow, on an unverified call, a receive-only link or with no dialog", async () => {
    const unverified = consenting(true);
    unverified.store.setIdentity("OE8APR", false);
    await unverified.store.connect("serial");
    await settle();
    expect(unverified.asked).toEqual([]);
    expect(await unverified.store.requestTx()).toBe(false);

    const audio = consenting(true);
    audio.store.setIdentity("OE8APR", true);
    await audio.store.connect("audio");
    await settle();
    expect(audio.asked).toEqual([]);
    await expect(audio.store.transmit(msgFrame("OE8APR-7"), "My radio")).rejects.toThrow();

    const { store } = fakeRadio();
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    expect(await store.requestTx()).toBe(false);
  });

  it("ends the grant on disconnect and on the loss of the device", async () => {
    const { r, store } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    expect(store.canTransmit()).toBe(true);
    await store.disconnect();
    expect(store.getState().txOn).toBe(false);
    store.setConsentAsker(() => Promise.resolve(false));
    await store.connect("serial");
    await settle();
    expect(store.canTransmit()).toBe(false);
    store.setConsentAsker(() => Promise.resolve(true));
    expect(await store.requestTx()).toBe(true);
    r.lose(new Error("unplugged"));
    expect(store.getState().txOn).toBe(false);
    expect(store.canTransmit()).toBe(false);
  });

  it("ends the grant on sign-out, a change of callsign or SSID, and the loss of verification", async () => {
    const { store } = consenting(true);
    const grant = async () => {
      if (!store.getState().link) await store.connect("serial");
      expect(await store.requestTx()).toBe(true);
    };
    store.setIdentity("OE8APR", true);
    await grant();
    store.setIdentity("OE8APR", false);
    expect(store.getState().txOn).toBe(false);
    store.setIdentity("OE8APR", true);
    expect(store.getState().txOn).toBe(false);
    await grant();
    store.setSsid("9");
    expect(store.getState().txOn).toBe(false);
    await grant();
    store.setIdentity("OE8XBM", true);
    await settle();
    expect(store.getState()).toMatchObject({ txOn: false, link: null });
    await grant();
    store.setIdentity("", false);
    await settle();
    expect(store.getState().txOn).toBe(false);
  });

  it("drops an answer that arrives after the callsign it was asked for changed", async () => {
    let allow: (v: boolean) => void = () => {};
    const { store } = consenting(() => new Promise<boolean>((res) => (allow = res)));
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    const asking = store.requestTx();
    store.setSsid("5");
    allow(true);
    expect(await asking).toBe(false);
    expect(store.canTransmit()).toBe(false);
  });

  it("shows one dialog for requests made while it is open", async () => {
    let allow: (v: boolean) => void = () => {};
    const { store, asked } = consenting(() => new Promise<boolean>((res) => (allow = res)));
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    const second = store.requestTx();
    allow(true);
    expect(await second).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("transmits only as the callsign the grant was given for", async () => {
    const { r, store } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    await expect(store.transmit(msgFrame("OE8XBM-7"), "My radio")).rejects.toThrow(/OE8APR-7 only/);
    expect(r.sent).toEqual([]);
  });

  it("sends the text it originates as UTF-8 bytes, and lists the text it sent", async () => {
    const { r, store } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    const text = ":OE8XBM   :Grüße 73 €{5";
    await store.transmit({ src: store.txCall(), dst: "APRS", path: ["WIDE1-1"], payload: text }, "Messages");
    const sent = r.sent[0] as { payload: string };
    // one character per byte, the bytes of the UTF-8 encoding: what encodeAx25 writes to the TNC
    expect(sent.payload).toBe(String.fromCharCode(...new TextEncoder().encode(text)));
    const info = encodeAx25({ src: "OE8APR-7", dst: "APRS", payload: sent.payload }).subarray(16);
    expect(new TextDecoder().decode(info)).toBe(text);
    expect(store.getState().sent[0]?.summary).toContain("Grüße 73 €");
  });

  it("keeps the grant in this tab only: nothing goes to storage and a new tab starts without one", async () => {
    const writes: string[] = [];
    const storage = { setItem: (k: string) => writes.push(k), getItem: () => null, removeItem: () => {} };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      const { store } = consenting(true);
      store.setIdentity("OE8APR", true);
      await store.connect("serial");
      await settle();
      await store.transmit(msgFrame(store.txCall()), "My radio");
      expect(store.canTransmit()).toBe(true);
      expect(writes).toEqual([]);
      const fresh = fakeRadio().store;
      fresh.setIdentity("OE8APR", true);
      await fresh.connect("serial");
      expect(fresh.canTransmit()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records every transmission, raises a tx event per frame and keeps the last TX_KEPT", async () => {
    const { store, events } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    for (let i = 1; i <= TX_KEPT + 5; i++) await store.transmit(msgFrame(store.txCall(), i), "Messages");
    const tx = events.filter((e) => e.kind === "tx");
    expect(tx).toHaveLength(TX_KEPT + 5);
    const { sent, txCount } = store.getState();
    expect(sent).toHaveLength(TX_KEPT);
    expect(txCount).toBe(TX_KEPT + 5);
    expect(sent[0]).toMatchObject({
      src: "OE8APR-7",
      dst: "APRS",
      path: ["WIDE1-1"],
      to: "OE8XBM",
      summary: "message to OE8XBM: hi",
      feature: "Messages",
    });
    store.clearSent();
    expect(store.getState()).toMatchObject({ sent: [], txCount: TX_KEPT + 5 });
  });

  it("forgets the transmissions with the account that sent them", async () => {
    const { store } = consenting(true);
    store.setIdentity("OE8APR", true);
    await store.connect("serial");
    await settle();
    await store.transmit(msgFrame(store.txCall()), "My radio");
    store.setIdentity("", false);
    expect(store.getState().sent).toEqual([]);
  });

  it("gates the packet terminal's own port with the same consent, ended by closing it or a revoke", async () => {
    const { store, asked, events } = consenting(true);
    store.setIdentity("OE8APR", true);
    store.setTerminal("the USB TNC", "oe8apr-1");
    await settle();
    expect(asked).toEqual([{ who: "terminal", call: "OE8APR-1", via: "the USB TNC" }]);
    expect(store.getState().termTx).toBe(true);
    store.recordTx({
      src: "OE8APR-1",
      dst: "OE8XBM",
      path: [],
      to: "OE8XBM",
      summary: "connect request",
      feature: "Terminal",
    });
    expect(events.at(-1)).toMatchObject({ kind: "tx", entry: { feature: "Terminal" } });
    store.revokeTx();
    expect(store.getState().termTx).toBe(false);
    expect(await store.requestTx("terminal")).toBe(true);
    store.setTerminal(null);
    expect(store.getState().termTx).toBe(false);
  });
});

describe("the words for a transmission", () => {
  it("summarises APRS payloads", () => {
    expect(aprsSummary(":OE8XBM   :hello there{12")).toBe("message to OE8XBM: hello there");
    expect(aprsSummary(":OE8XBM-7 :ack12")).toBe("acknowledgement 12 to OE8XBM-7");
    expect(aprsSummary("!4700.00N/01300.00E>")).toBe("position");
    expect(aprsSummary(">on the air")).toBe("status: on the air");
    expect(aprsSummary(";CACHE1   *111111z4700.00N/01300.00E?")).toBe("object CACHE1");
    expect(aprsSummary("x".repeat(100))).toHaveLength(60);
  });

  it("summarises connected-mode frames", () => {
    const f = (type: Ax25Frame["type"], info?: string): Ax25Frame => ({
      src: { call: "OE8APR", ssid: 1 },
      dst: { call: "OE8XBM", ssid: 0 },
      digis: [{ call: "WIDE1", ssid: 1 }],
      command: true,
      type,
      pf: true,
      info: info == null ? undefined : new TextEncoder().encode(info),
    });
    expect(ax25Summary(f("SABM"))).toBe("connect request");
    expect(ax25Summary(f("I", "B\r"))).toBe("text: B");
    expect(ax25Summary(f("RR"))).toBe("acknowledge");
    expect(terminalTxNote(f("DISC"))).toMatchObject({
      src: "OE8APR-1",
      dst: "OE8XBM",
      path: ["WIDE1-1"],
      summary: "disconnect",
      feature: "Terminal",
    });
  });

  it("announces at most once per gap, naming the latest destination", () => {
    const said: string[] = [];
    let now = 0;
    const timers: (() => void)[] = [];
    const a = new TxAnnouncer((t) => said.push(t), {
      now: () => now,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    a.note("OE8XBM");
    a.note("OE8ABC");
    a.note("OE8DEF");
    expect(said).toEqual(["Transmitted to OE8XBM"]);
    expect(timers).toHaveLength(1);
    now = ANNOUNCE_GAP_MS;
    timers[0]!();
    expect(said).toEqual(["Transmitted to OE8XBM", "Transmitted to OE8DEF"]);
    now += ANNOUNCE_GAP_MS;
    a.note("APRS");
    expect(said.at(-1)).toBe("Transmitted to APRS");
  });
});

describe("the soundcard modem in the radio link", () => {
  function noteRadio(fail?: string) {
    const events: string[] = [];
    const deps: RadioDeps = {
      makeLink: () => ({
        note: "Direwolf modem (SIMD)",
        async connect() {
          if (fail) throw new Error(fail);
        },
        async disconnect() {},
        async send() {},
      }),
      forward: () => Promise.resolve(),
      feedLocal: () => {},
    };
    const store = new RadioLinkStore(deps);
    store.onEvent((e) => events.push(e.kind));
    return { store, events };
  }

  it("shows the link's note while it is up, and clears it on disconnect", async () => {
    const { store } = noteRadio();
    expect(store.getState().linkNote).toBe("");
    await store.connect("audio");
    expect(store.getState().linkNote).toBe("Direwolf modem (SIMD)");
    await store.disconnect();
    expect(store.getState().linkNote).toBe("");
  });

  it("keeps why a connect failed for the link's status", async () => {
    const { store, events } = noteRadio("the soundcard modem could not load (404)");
    await store.connect("audio");
    expect(store.getState().link).toBeNull();
    expect(store.getState().linkError).toBe("the soundcard modem could not load (404)");
    expect(events).toEqual(["connect-failed"]);
  });

  it("clears the error as a new attempt starts", async () => {
    let fail = true;
    const store = new RadioLinkStore({
      makeLink: () => ({
        async connect() {
          if (fail) throw new Error("no modem");
        },
        async disconnect() {},
        async send() {},
      }),
      forward: () => Promise.resolve(),
      feedLocal: () => {},
    });
    await store.connect("hf");
    expect(store.getState().linkError).toBe("no modem");
    fail = false;
    await store.connect("hf");
    expect(store.getState().linkError).toBe("");
    expect(store.getState().link).toBe("hf");
  });
});
