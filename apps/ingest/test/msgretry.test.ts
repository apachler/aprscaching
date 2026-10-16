// SPDX-License-Identifier: AGPL-3.0-or-later
// Message repeats: a numbered message the box sends is sent again on the decaying schedule until its addressee
// acks or rejects it, through the same gates as the first send, and its outcome is reported to the gateway.
import { describe, it, expect } from "vitest";
import { MessageRetrier, RETRY_GAPS_HF_SEC, ackOf, retrySpanMs } from "@aprscaching/aprs";
import { BoxPoller, type BoxCommand, type BoxPollerOpts, type BoxState } from "../src/boxpoll.js";
import { outboxMessage } from "../src/uplink.js";
import { AprsIs } from "../src/aprsis.js";

type Sent = { src: string; dst: string; path?: string[]; payload: string };

function setup(over: Partial<BoxPollerOpts> = {}) {
  const sent: Sent[] = [];
  const posts: unknown[] = [];
  let t = 1_700_000_000_000;
  let radioOk = true;
  const state: BoxState = { tx: true, digi: null, igate: null };
  const poller = new BoxPoller({
    base: "http://gw",
    secret: "s",
    boxId: "pi",
    boxCall: "OE8APR-10",
    remoteTx: true,
    radio: {
      send: (f) => {
        if (radioOk) sent.push(f);
        return radioOk;
      },
    },
    state,
    burst: 10,
    refillSec: 6,
    serviceCall: "APRSCG",
    now: () => t,
    log: () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/commands/ack")) posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ commands: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    ...over,
  });
  /** Advance the clock and run the repeats, as the box's 5 s timer does. */
  const run = (sec: number) => {
    for (let i = 0; i < sec; i += 5) {
      t += 5000;
      poller.retrier.tick();
    }
  };
  const nowSec = () => Math.floor(t / 1000);
  return {
    poller,
    sent,
    posts,
    state,
    run,
    nowSec,
    refuse: (v: boolean) => {
      radioOk = !v;
    },
  };
}

const message = (createdAt: number, id = 7): BoxCommand => ({
  id,
  kind: "message",
  callsign: "OE8APR-10",
  createdAt,
  payload: { to: "OE3ABC", text: "QSL?" },
});

describe("box message repeats", () => {
  it("repeats 30 s, 1, 2 and 4 min apart, then gives up 8 min after the fifth try and reports it", async () => {
    const { poller, sent, posts, run, nowSec } = setup();
    const r = await poller.execute(message(nowSec()));
    expect(r).toMatchObject({ status: "done", msgNo: expect.stringMatching(/^\d+$/) });
    expect(sent).toHaveLength(1);
    run(25);
    expect(sent).toHaveLength(1);
    run(5);
    expect(sent).toHaveLength(2);
    run(60);
    expect(sent).toHaveLength(3);
    run(120);
    expect(sent).toHaveLength(4);
    run(240);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.payload)).size).toBe(1);
    run(475);
    expect(poller.retrier.waiting).toBe(1);
    run(10);
    expect(poller.retrier.waiting).toBe(0);
    expect(sent).toHaveLength(5);
    expect(poller.retrier.stats).toMatchObject({ retries: 4, expired: 1, acked: 0 });
    await poller.tick();
    expect(posts).toContainEqual({ id: 7, delivery: { tries: 5, outcome: "expired" } });
  });

  it("stops at the addressee's ack of its number, addressed to the sender", async () => {
    const { poller, sent, run, nowSec } = setup();
    const r = await poller.execute(message(nowSec()));
    run(30);
    expect(sent).toHaveLength(2);
    // an ack from another station, or of another number, settles nothing
    poller.heard("OE3XYZ", `:OE8APR-10:ack${r.msgNo}`);
    poller.heard("OE3ABC", `:OE8APR-10:ack${r.msgNo === "1" ? "2" : "1"}`);
    poller.heard("OE3ABC", `:OE8APR-11:ack${r.msgNo}`);
    expect(poller.retrier.waiting).toBe(1);
    poller.heard("OE3ABC", `:OE8APR-10:ack${r.msgNo}`);
    expect(poller.retrier.waiting).toBe(0);
    run(600);
    expect(sent).toHaveLength(2);
    expect(poller.retrier.stats).toMatchObject({ acked: 1, retries: 1 });
  });

  it("stops at a reply-ack carried in the addressee's own message, and at a rej", async () => {
    const { poller, nowSec } = setup();
    const a = await poller.execute(message(nowSec(), 1));
    const b = await poller.execute(message(nowSec(), 2));
    poller.heard("OE3ABC", `:OE8APR-10:Yes, QSL{12}${a.msgNo}`);
    poller.heard("OE3ABC", `:OE8APR-10:rej${b.msgNo}`);
    expect(poller.retrier.waiting).toBe(0);
    expect(poller.retrier.stats).toMatchObject({ acked: 1, rejected: 1 });
  });

  it("repeats a numbered Mailbox answer from the service call until the station acks the service call", async () => {
    const { poller, sent, run, nowSec } = setup();
    await poller.execute({
      id: 9,
      kind: "aprs_msg",
      createdAt: nowSec(),
      payload: { from: "APRSCG", to: "OE3ABC-7", text: "de OE5XYZ: hi", msgNo: "M12" },
    });
    run(30);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload).toBe(sent[0]!.payload);
    poller.heard("OE3ABC-7", ":APRSCG   :ackM12");
    expect(poller.retrier.waiting).toBe(0);
  });

  it("an answer without a number goes out once", async () => {
    const { poller, sent, run, nowSec } = setup();
    await poller.execute({
      id: 9,
      kind: "aprs_msg",
      createdAt: nowSec(),
      payload: { from: "APRSCG", to: "OE3ABC", text: "Logged" },
    });
    run(600);
    expect(sent).toHaveLength(1);
  });

  it("switching transmit off stops the repeats; a refusing radio holds a try without counting it", async () => {
    const { poller, sent, state, run, refuse, nowSec } = setup();
    await poller.execute(message(nowSec(), 1));
    refuse(true);
    run(60);
    expect(poller.retrier.list()[0]!.tries).toBe(1);
    refuse(false);
    run(15);
    expect(sent).toHaveLength(2);
    state.tx = false;
    run(120);
    expect(poller.retrier.waiting).toBe(0);
    expect(poller.retrier.stats.cancelled).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("an HF radio repeats 2, 4, 8, 16 min apart and up to 30, ten tries", async () => {
    const sent: Sent[] = [];
    const { poller, run, nowSec } = setup({
      radio: {
        hf: true,
        send: (f) => {
          sent.push(f);
          return true;
        },
      },
    });
    await poller.execute(message(nowSec()));
    run(115);
    expect(sent).toHaveLength(1);
    run(5);
    expect(sent).toHaveLength(2);
    run(240);
    expect(sent).toHaveLength(3);
    run(retrySpanMs(true) / 1000);
    expect(sent).toHaveLength(RETRY_GAPS_HF_SEC.length);
    expect(poller.retrier.stats.expired).toBe(1);
  });
});

describe("the retry engine", () => {
  it("reads acks, rejs and reply-acks, also inside third-party traffic", () => {
    expect(ackOf("OE3ABC", ":OE8APR   :ack5")).toEqual({ from: "OE3ABC", to: "OE8APR", msgNo: "5", rej: false });
    expect(ackOf("OE3ABC", ":OE8APR   :rej5")).toMatchObject({ rej: true });
    expect(ackOf("OE3ABC", ":OE8APR   :hi{7}5")).toMatchObject({ msgNo: "5" });
    expect(ackOf("OE3ABC", ":OE8APR   :hi{7}")).toBeNull();
    expect(ackOf("IGATE", "}OE3ABC>APRS,TCPIP,IGATE*::OE8APR   :ack5")).toMatchObject({ from: "OE3ABC" });
    expect(ackOf("OE3ABC", "!4700.00N/01500.00E-")).toBeNull();
  });

  it("drops the oldest message for a new one beyond its bound", () => {
    const r = new MessageRetrier({ now: () => 0, resend: () => "sent", maxPending: 2 });
    for (const n of ["1", "2", "3"]) r.track({ from: "A", to: "B", msgNo: n });
    expect(r.list().map((m) => m.msgNo)).toEqual(["2", "3"]);
    expect(r.stats.cancelled).toBe(1);
  });

  it("an outbox item's numbered message, never an ack or an unnumbered one", () => {
    expect(outboxMessage({ src_call: "oe8apr", payload: ":OE3ABC   :hi{42" })).toEqual({
      from: "OE8APR",
      to: "OE3ABC",
      msgNo: "42",
    });
    expect(outboxMessage({ src_call: "APRSCG", payload: ":OE3ABC   :ack42" })).toBeNull();
    expect(outboxMessage({ src_call: "APRSCG", payload: ":OE3ABC   :hi" })).toBeNull();
    expect(outboxMessage({ src_call: "APRSCG", payload: ">status" })).toBeNull();
  });

  it("the APRS-IS feed asks for the messages of a sender waiting for its ack", () => {
    const feed = new AprsIs({ host: "h", port: 1, callsign: "N0CALL", passcode: "-1", filter: "r/47/15/100" });
    feed.setServiceCall("aprscg");
    feed.watch(["oe8apr-7", "OE8APR-7"]);
    expect(feed.filter()).toBe("r/47/15/100 g/APRSCG/OE8APR-7");
    feed.watch([]);
    expect(feed.filter()).toBe("r/47/15/100 g/APRSCG");
  });
});
