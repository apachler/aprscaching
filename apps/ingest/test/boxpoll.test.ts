// SPDX-License-Identifier: AGPL-3.0-or-later
// The box-side remote-control poller: lease → execute → ack, and the box's own transmit gates
// (opt-in, own station call, command age, rate limit) that hold even when the gateway let a command through.
import { describe, it, expect } from "vitest";
import { BoxPoller, parseBoxPath, type BoxCommand, type BoxPollerOpts, type BoxState } from "../src/boxpoll.js";

type Sent = { src: string; dst: string; path?: string[]; payload: string };

function setup(over: Partial<BoxPollerOpts> = {}) {
  const sent: Sent[] = [];
  let t = 1_700_000_000_000;
  const state: BoxState = { tx: true, digi: true, igate: false };
  const poller = new BoxPoller({
    base: "http://gw",
    secret: "s",
    boxId: "pi-home",
    boxCall: "OE8APR-10",
    remoteTx: true,
    radio: {
      send: (f) => {
        sent.push(f);
        return true;
      },
    },
    state,
    now: () => t,
    log: () => {},
    ...over,
  });
  const nowSec = () => Math.floor(t / 1000);
  const advance = (ms: number) => {
    t += ms;
  };
  return { poller, sent, state, nowSec, advance };
}

const cmd = (c: Partial<BoxCommand>): BoxCommand => ({ id: 1, kind: "status", callsign: "OE8APR", ...c });

describe("remote transmit", () => {
  it("beacons a position as the command's callsign through the radio", () => {
    const { poller, sent, nowSec } = setup();
    const r = poller.execute(
      cmd({
        kind: "beacon",
        callsign: "OE8APR-7",
        createdAt: nowSec(),
        payload: { lat: 47.07, lon: 15.42, comment: "hi" },
      }),
    );
    expect(r.status).toBe("done");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ src: "OE8APR-7", dst: "APZACG", path: ["WIDE1-1", "WIDE2-1"] });
    expect(sent[0]!.payload).toBe("!4704.20N/01525.20E-hi");
  });

  it("sends an APRS message to the addressee", () => {
    const { poller, sent, nowSec } = setup();
    const r = poller.execute(cmd({ kind: "message", createdAt: nowSec(), payload: { to: "oe3abc", text: "QSL" } }));
    expect(r.status).toBe("done");
    expect(sent[0]!.payload).toBe(":OE3ABC   :QSL");
  });

  it("refuses when the operator has not opted in on the box", () => {
    const { poller, sent, nowSec } = setup({ remoteTx: false });
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r).toMatchObject({ status: "failed" });
    expect(r.result).toMatch(/BOX_TX=1/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a callsign that is not the box's own station call", () => {
    const { poller, sent, nowSec } = setup();
    const r = poller.execute(
      cmd({ kind: "beacon", callsign: "OE3ABC", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }),
    );
    expect(r.status).toBe("failed");
    expect(r.result).toMatch(/not this box's station call/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when no station call is configured", () => {
    const { poller, nowSec } = setup({ boxCall: undefined });
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/BOX_CALL/);
  });

  it("refuses a command queued longer ago than the maximum age", () => {
    const { poller, sent, nowSec } = setup({ maxAgeSec: 600 });
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec() - 601, payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/expired/);
    expect(sent).toHaveLength(0);
  });

  it("refuses without a radio", () => {
    const { poller, nowSec } = setup({ radio: null });
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/no RF transmitter/);
  });

  it("refuses while the master transmit switch is off", () => {
    const { poller, state, sent, nowSec } = setup();
    state.tx = false;
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/switched off/);
    expect(sent).toHaveLength(0);
  });

  it("rate-limits a burst, then refills one token per interval", () => {
    const { poller, sent, nowSec, advance } = setup({ burst: 2, refillSec: 60 });
    const beacon = () => poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(beacon().status).toBe("done");
    expect(beacon().status).toBe("done");
    expect(beacon().result).toMatch(/rate limited/);
    advance(60_000);
    expect(beacon().status).toBe("done");
    expect(beacon().result).toMatch(/rate limited/);
    expect(sent).toHaveLength(3);
  });

  it("does not spend a rate-limit token on a refused command", () => {
    const { poller, nowSec } = setup({ burst: 1 });
    poller.execute(cmd({ kind: "beacon", callsign: "OE3ABC", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    const r = poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.status).toBe("done");
  });

  it("rejects malformed payloads", () => {
    const { poller, nowSec } = setup();
    expect(poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 91, lon: 0 } })).status).toBe(
      "failed",
    );
    expect(
      poller.execute(cmd({ kind: "message", createdAt: nowSec(), payload: { to: "OE3ABC", text: " " } })).status,
    ).toBe("failed");
    expect(
      poller.execute(cmd({ kind: "message", createdAt: nowSec(), payload: { to: "BAD CALL!", text: "x" } })).status,
    ).toBe("failed");
  });
});

describe("switches", () => {
  it("switching transmit off is always honoured, even with remote transmit disabled", () => {
    const { poller, state } = setup({ remoteTx: false });
    const r = poller.execute(cmd({ kind: "tx", callsign: "OE3ABC", payload: { on: false } }));
    expect(r.status).toBe("done");
    expect(state.tx).toBe(false);
  });

  it("switching a function on needs the opt-in and the station call", () => {
    const { poller, state } = setup();
    expect(poller.execute(cmd({ kind: "igate", callsign: "OE3ABC", payload: { on: true } })).status).toBe("failed");
    expect(state.igate).toBe(false);
    expect(poller.execute(cmd({ kind: "igate", payload: { on: true } })).status).toBe("done");
    expect(state.igate).toBe(true);

    const off = setup({ remoteTx: false });
    expect(off.poller.execute(cmd({ kind: "digi", payload: { on: true } })).result).toMatch(/BOX_TX=1/);
  });

  it("reports a function that is not configured", () => {
    const { poller, state } = setup();
    state.digi = null;
    expect(poller.execute(cmd({ kind: "digi", payload: { on: false } })).result).toMatch(/no digipeater/);
  });

  it("needs an explicit on flag", () => {
    const { poller } = setup();
    expect(poller.execute(cmd({ kind: "tx", payload: {} })).status).toBe("failed");
  });
});

describe("status and unknown kinds", () => {
  it("summarises the box state", () => {
    const { poller, advance } = setup();
    advance(3_720_000);
    const r = poller.execute(cmd({ kind: "status" }));
    expect(r).toEqual({
      status: "done",
      result: "up 1h02m · rf kiss · tx on · digi on · igate off · remote tx allowed",
    });
  });

  it("fails a kind the box cannot run", () => {
    const { poller } = setup();
    expect(poller.execute(cmd({ kind: "wx_beacon" }))).toEqual({
      status: "failed",
      result: "wx_beacon is not supported by this box",
    });
  });
});

describe("poll loop", () => {
  function fakeGateway(commands: BoxCommand[], ackOk: () => boolean = () => true) {
    const acks: unknown[] = [];
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/commands")) {
        const out = commands.splice(0);
        return new Response(JSON.stringify({ commands: out }), { status: 200 });
      }
      if (!ackOk()) return new Response("down", { status: 503 });
      acks.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { f, acks, calls };
  }

  it("leases with the secret, executes and acks each command", async () => {
    const gw = fakeGateway([cmd({ id: 7, kind: "status" }), cmd({ id: 8, kind: "tx", payload: { on: false } })]);
    const { poller, state } = setup({ fetch: gw.f });
    await poller.tick();
    expect(gw.calls[0]).toBe("GET http://gw/api/box/pi-home/commands");
    expect(gw.acks).toEqual([
      expect.objectContaining({ id: 7, status: "done" }),
      { id: 8, status: "done", result: "transmit off" },
    ]);
    expect(state.tx).toBe(false);
  });

  it("keeps acks the gateway refused and delivers them on the next tick", async () => {
    let up = false;
    const gw = fakeGateway([cmd({ id: 9, kind: "status" })], () => up);
    const { poller } = setup({ fetch: gw.f });
    await poller.tick();
    expect(gw.acks).toHaveLength(0);
    up = true;
    await poller.tick();
    expect(gw.acks).toEqual([expect.objectContaining({ id: 9, status: "done" })]);
  });

  it("survives a gateway that is down", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { poller } = setup({ fetch: f });
    await expect(poller.tick()).resolves.toBeUndefined();
  });
});

describe("parseBoxPath", () => {
  it("defaults to WIDE1-1,WIDE2-1 and accepts an empty path", () => {
    expect(parseBoxPath(undefined)).toEqual(["WIDE1-1", "WIDE2-1"]);
    expect(parseBoxPath("")).toEqual([]);
    expect(parseBoxPath(" wide2-2 ")).toEqual(["WIDE2-2"]);
  });
});
