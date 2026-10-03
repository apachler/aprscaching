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
  it("beacons a position as the command's callsign through the radio", async () => {
    const { poller, sent, nowSec } = setup();
    const r = await poller.execute(
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

  it("sends an APRS message to the addressee, numbered so it is acknowledged", async () => {
    const { poller, sent, nowSec } = setup();
    const r = await poller.execute(
      cmd({ kind: "message", createdAt: nowSec(), payload: { to: "oe3abc", text: "QSL" } }),
    );
    expect(r.status).toBe("done");
    expect(sent[0]!.payload).toMatch(/^:OE3ABC {3}:QSL\{\d{1,5}$/);
    await poller.execute(cmd({ id: 2, kind: "message", createdAt: nowSec(), payload: { to: "OE3ABC", text: "73" } }));
    const n = (s: string) => Number(s.split("{")[1]);
    expect(n(sent[1]!.payload)).toBe((n(sent[0]!.payload) % 99_999) + 1);
  });

  it("refuses when the operator has not opted in on the box", async () => {
    const { poller, sent, nowSec } = setup({ remoteTx: false });
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r).toMatchObject({ status: "failed" });
    expect(r.result).toMatch(/BOX_TX=1/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a callsign that is not the box's own station call", async () => {
    const { poller, sent, nowSec } = setup();
    const r = await poller.execute(
      cmd({ kind: "beacon", callsign: "OE3ABC", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }),
    );
    expect(r.status).toBe("failed");
    expect(r.result).toMatch(/not this box's station call/);
    expect(sent).toHaveLength(0);
  });

  it("refuses when no station call is configured", async () => {
    const { poller, nowSec } = setup({ boxCall: undefined });
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/BOX_CALL/);
  });

  it("refuses a command queued longer ago than the maximum age", async () => {
    const { poller, sent, nowSec } = setup({ maxAgeSec: 600 });
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec() - 601, payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/expired/);
    expect(sent).toHaveLength(0);
  });

  it("refuses without a radio", async () => {
    const { poller, nowSec } = setup({ radio: null });
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/no RF transmitter/);
  });

  it("refuses while the master transmit switch is off", async () => {
    const { poller, state, sent, nowSec } = setup();
    state.tx = false;
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.result).toMatch(/switched off/);
    expect(sent).toHaveLength(0);
  });

  it("rate-limits a burst, then refills one token per interval", async () => {
    const { poller, sent, nowSec, advance } = setup({ burst: 2, refillSec: 60 });
    const beacon = async () =>
      poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect((await beacon()).status).toBe("done");
    expect((await beacon()).status).toBe("done");
    expect((await beacon()).result).toMatch(/rate limited/);
    advance(60_000);
    expect((await beacon()).status).toBe("done");
    expect((await beacon()).result).toMatch(/rate limited/);
    expect(sent).toHaveLength(3);
  });

  it("does not spend a rate-limit token on a refused command", async () => {
    const { poller, nowSec } = setup({ burst: 1 });
    await poller.execute(cmd({ kind: "beacon", callsign: "OE3ABC", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    const r = await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 1, lon: 2 } }));
    expect(r.status).toBe("done");
  });

  it("rejects malformed payloads", async () => {
    const { poller, nowSec } = setup();
    expect(
      (await poller.execute(cmd({ kind: "beacon", createdAt: nowSec(), payload: { lat: 91, lon: 0 } }))).status,
    ).toBe("failed");
    expect(
      (await poller.execute(cmd({ kind: "message", createdAt: nowSec(), payload: { to: "OE3ABC", text: " " } })))
        .status,
    ).toBe("failed");
    expect(
      (await poller.execute(cmd({ kind: "message", createdAt: nowSec(), payload: { to: "BAD CALL!", text: "x" } })))
        .status,
    ).toBe("failed");
  });
});

describe("switches", () => {
  it("switching transmit off is always honoured, even with remote transmit disabled", async () => {
    const { poller, state } = setup({ remoteTx: false });
    const r = await poller.execute(cmd({ kind: "tx", callsign: "OE3ABC", payload: { on: false } }));
    expect(r.status).toBe("done");
    expect(state.tx).toBe(false);
  });

  it("switching a function on needs the opt-in and the station call", async () => {
    const { poller, state } = setup();
    expect((await poller.execute(cmd({ kind: "igate", callsign: "OE3ABC", payload: { on: true } }))).status).toBe(
      "failed",
    );
    expect(state.igate).toBe(false);
    expect((await poller.execute(cmd({ kind: "igate", payload: { on: true } }))).status).toBe("done");
    expect(state.igate).toBe(true);

    const off = setup({ remoteTx: false });
    expect((await off.poller.execute(cmd({ kind: "digi", payload: { on: true } }))).result).toMatch(/BOX_TX=1/);
  });

  it("reports a function that is not configured", async () => {
    const { poller, state } = setup();
    state.digi = null;
    expect((await poller.execute(cmd({ kind: "digi", payload: { on: false } }))).result).toMatch(/no digipeater/);
  });

  it("needs an explicit on flag", async () => {
    const { poller } = setup();
    expect((await poller.execute(cmd({ kind: "tx", payload: {} }))).status).toBe("failed");
  });
});

describe("status and unknown kinds", () => {
  it("summarises the box state", async () => {
    const { poller, advance } = setup();
    advance(3_720_000);
    const r = await poller.execute(cmd({ kind: "status" }));
    expect(r).toEqual({
      status: "done",
      result: "up 1h02m · rf kiss · tx on · digi on · igate off · remote tx allowed",
    });
  });

  it("fails a kind the box cannot run", async () => {
    const { poller } = setup();
    expect(await poller.execute(cmd({ kind: "wx_beacon" }))).toEqual({
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
      if (url.includes("/commands?") || url.endsWith("/commands")) {
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
    expect(gw.calls[0]).toBe("GET http://gw/api/box/pi-home/commands?tx=1&rf=1&meshcom=");
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

describe("answers to radio commands", () => {
  const answer = (o: Partial<BoxCommand> = {}): BoxCommand => ({
    id: 5,
    kind: "aprs_msg",
    callsign: null,
    payload: { from: "APRSCG", to: "OE8APR-7", text: "ack12" },
    ...o,
  });

  it("sends an APRS answer on RF as third-party traffic from the service call, under the box's call", async () => {
    const { poller, sent, nowSec } = setup();
    const r = await poller.execute(answer({ createdAt: nowSec() }));
    expect(r).toEqual({ status: "done", result: "answer to OE8APR-7 sent as OE8APR-10" });
    expect(sent).toEqual([
      {
        src: "OE8APR-10",
        dst: "APZACG",
        path: ["WIDE1-1", "WIDE2-1"],
        payload: "}APRSCG>APZACG,TCPIP,OE8APR-10*::OE8APR-7 :ack12",
      },
    ]);
  });

  it("only speaks for the configured service call", async () => {
    const { poller, sent } = setup({ serviceCall: "OE8APR-5" });
    expect((await poller.execute(answer())).result).toMatch(/only answers from OE8APR-5/);
    expect(sent).toHaveLength(0);
  });

  it("speaks for the service call the gateway names in its poll", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ serviceCall: "OE8APR-15", commands: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const { poller, sent, nowSec } = setup({ fetch: f });
    await poller.tick();
    expect((await poller.execute(answer({ createdAt: nowSec() }))).result).toMatch(/only answers from OE8APR-15/);
    const r = await poller.execute(
      answer({ createdAt: nowSec(), payload: { from: "OE8APR-15", to: "OE8APR-7", text: "ack12" } }),
    );
    expect(r.status).toBe("done");
    expect(sent[0]!.payload).toBe("}OE8APR-15>APZACG,TCPIP,OE8APR-10*::OE8APR-7 :ack12");
  });

  it("passes the opt-in, transmit switch and age gates", async () => {
    expect((await setup({ remoteTx: false }).poller.execute(answer())).result).toMatch(/BOX_TX=1/);
    const off = setup();
    off.state.tx = false;
    expect((await off.poller.execute(answer())).result).toMatch(/switched off/);
    const old = setup({ maxAgeSec: 60 });
    expect((await old.poller.execute(answer({ createdAt: old.nowSec() - 61 }))).result).toMatch(/expired/);
    expect((await setup({ radio: null }).poller.execute(answer())).result).toMatch(/no RF transmitter/);
  });

  it("hands a MeshCom answer to the node that heard the message", async () => {
    const calls: unknown[] = [];
    const { poller } = setup({
      meshcom: {
        nodes: [{ ip: "192.168.1.50", call: "OE8APR-12" }],
        send: async (req) => {
          calls.push(req);
          return { ok: true };
        },
      },
    });
    const r = await poller.execute(
      answer({ kind: "meshcom_msg", payload: { node: "OE8APR-12", dst: "OE8APR-7", text: "OE8APR-7 :ack034" } }),
    );
    expect(r.status).toBe("done");
    expect(calls).toEqual([
      { dst: "OE8APR-7", text: "OE8APR-7 :ack034", feature: "radio-answer", node: "192.168.1.50" },
    ]);
  });

  it("reports why a MeshCom answer was not sent", async () => {
    const off = setup();
    expect(
      (
        await off.poller.execute(
          answer({ kind: "meshcom_msg", payload: { node: "OE8APR-12", dst: "OE8APR-7", text: "x" } }),
        )
      ).result,
    ).toMatch(/MESHCOM_TX=1/);
    const { poller } = setup({
      meshcom: {
        nodes: [{ ip: "192.168.1.50", call: "OE8APR-12" }],
        send: async () => ({ ok: false, reason: "rate-limited" }),
      },
    });
    const node = (n: string) => answer({ kind: "meshcom_msg", payload: { node: n, dst: "OE8APR-7", text: "x" } });
    expect((await poller.execute(node("OE8APR-99"))).result).toMatch(/no MeshCom node OE8APR-99/);
    expect((await poller.execute(node("OE8APR-12"))).result).toBe("MeshCom node refused: rate-limited");
  });

  it("reports what it can transmit with every poll", () => {
    const { poller, state } = setup({
      meshcom: { nodes: [{ ip: "1", call: "oe8apr-12" }, { ip: "2" }], send: async () => ({ ok: true }) },
    });
    expect(poller.capsQuery()).toBe("tx=1&rf=1&meshcom=OE8APR-12");
    state.tx = false;
    expect(poller.capsQuery()).toBe("tx=0&rf=1&meshcom=OE8APR-12");
    expect(setup({ remoteTx: false, radio: null }).poller.capsQuery()).toBe("tx=0&rf=0&meshcom=");
  });
});

describe("pairing", () => {
  it("asks the gateway for a pairing code with the box secret and prints it for the operator", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const lines: string[] = [];
    const { poller } = setup({
      secret: "box-secret",
      log: (m) => lines.push(m),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ boxId: "pi-home", code: "ABCD-EFGH", expiresAt: 1_700_000_900 }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const code = await poller.requestPairingCode();
    expect(code).toBe("ABCD-EFGH");
    expect(calls[0]!.url).toBe("http://gw/api/box/pi-home/pair");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>)["x-ingest-secret"]).toBe("box-secret");
    expect(lines.join("\n")).toMatch(/pairing code for pi-home: ABCD-EFGH/);
  });

  it("a refused or failed pairing request is logged, never thrown", async () => {
    const lines: string[] = [];
    const { poller } = setup({
      log: (m) => lines.push(m),
      fetch: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    expect(await poller.requestPairingCode()).toBeNull();
    expect(lines.join("\n")).toMatch(/pairing code unavailable/);
  });
});
