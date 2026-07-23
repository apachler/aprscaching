// SPDX-License-Identifier: MIT
// Packet-stack hostile-peer robustness. These exercise the abnormal paths the loopback happy-path
// tests don't: a hung warm-up, a SABM flood, a poisoning NODES sprayer, an un-terminated byte
// stream, a failing BBS backend, and FBB loop-suppression.
import { describe, it, expect } from "vitest";
import { SessionServer } from "../src/session-server.js";
import { TerminalSession } from "../src/session.js";
import { NetromNode } from "../src/netrom-node.js";
import { encodeNodesBroadcast, type NodesDest } from "../src/netrom-wire.js";
import { makeLineDriver, type LineApp } from "../src/link-app.js";
import { BbsSession } from "../src/bbs.js";
import { ConnectSequencer } from "../src/netrom-connect-through.js";
import { FbbSession, type FbbMessage, type FbbStore } from "../src/fbb-session.js";
import { SessionStore } from "../src/fbb-scheduler.js";
import { CachedBbsStore, type CachedBbsBackend } from "../src/cached-bbs-store.js";
import type { Ax25Address, Ax25Frame } from "@aprscaching/ax25";

const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });
const sabm = (dst: Ax25Address, src: Ax25Address): Ax25Frame => ({ dst, src, command: true, type: "SABM", pf: true });
const ticks = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("the warming slot is reaped past its deadline", () => {
  it("a factory that never settles frees the slot on poll(), not forever", () => {
    let t = 0;
    const events: string[] = [];
    const server = new SessionServer({
      send: () => {},
      services: [{ addr: A("OE8BBS"), name: "BBS", app: () => new Promise<LineApp>(() => {}) }], // never resolves
      clock: () => t,
      warmupDeadlineMs: 1000,
      onEvent: (e) => events.push(e.kind),
    });
    server.onFrame(sabm(A("OE8BBS"), A("OE1USR")));
    expect(server.count()).toBe(1); // slot reserved, still warming

    t = 500;
    server.poll();
    expect(server.count()).toBe(1); // within the deadline → kept

    t = 2000;
    server.poll();
    expect(server.count()).toBe(0); // past the deadline → reaped
    expect(events).toContain("refused");
  });
});

describe("bounded channels + scrollback", () => {
  it("refuses auto-accepted channels past the cap", () => {
    const s = new TerminalSession(
      "OE8APR-1",
      { send: () => {} },
      () => {},
      undefined,
      {},
      () => 0,
      500,
      2000,
      2,
    );
    s.onFrame(sabm(A("OE8APR", 1), A("OE1AAA")));
    s.onFrame(sabm(A("OE8APR", 1), A("OE2BBB")));
    s.onFrame(sabm(A("OE8APR", 1), A("OE3CCC"))); // over the cap of 2
    expect(s.channels.length).toBe(2);
  });

  it("caps per-channel scrollback", () => {
    const s = new TerminalSession(
      "OE8APR-1",
      { send: () => {} },
      () => {},
      undefined,
      {},
      () => 0,
      500,
      100,
      8,
    );
    const id = s.connect("OE8XBM-7");
    for (let i = 0; i < 400; i++) s.send(id, `line ${i}`);
    const ch = s.channels.find((c) => c.id === id)!;
    expect(ch.lines.length).toBeLessThanOrEqual(100);
    // the trim keeps the newest, drops the oldest
    expect(ch.lines.some((l) => l.text === "line 399")).toBe(true);
    expect(ch.lines.some((l) => l.text === "line 0")).toBe(false);
  });
});

describe("NODES table is bounded + rate-limited", () => {
  const bcast = (senderAlias: string, dests: NodesDest[]): Uint8Array => encodeNodesBroadcast(senderAlias, dests)[0]!;

  it("defaults maxRoutes so an unconfigured node can't grow unbounded", () => {
    let t = 0;
    // generous learn budget so the *table cap* (default 500), not the rate-limit, is what bounds growth
    const node = new NetromNode(
      { call: A("OE8NOD", 1), alias: "OENODE" },
      { pathQuality: 200, maxLearnsPerWindow: 100_000, clock: () => t },
    );
    // spray 2000 distinct destinations across many windows — the table must still stay at/under 500.
    for (let w = 0; w < 40; w++) {
      t += 61_000;
      const dests: NodesDest[] = [];
      for (let i = 0; i < 50; i++)
        dests.push({ dest: A(`D${w}X${i}`), alias: `A${i}`, neighbor: A("OE1N"), quality: 100 + (i % 50) });
      node.consume(bcast("N", dests), A("OE1N"));
    }
    expect(node.list().length).toBeLessThanOrEqual(500);
    expect(node.list().length).toBeGreaterThan(1); // it did learn real routes, just bounded
  });

  it("rate-limits how much one neighbour can teach per window (forged-broadcast churn guard)", () => {
    let t = 0;
    const node = new NetromNode(
      { call: A("OE8NOD", 1), alias: "OENODE" },
      { pathQuality: 200, maxLearnsPerWindow: 5, learnWindowMs: 60_000, clock: () => t },
    );
    const many: NodesDest[] = [];
    for (let i = 0; i < 50; i++) many.push({ dest: A(`OE3F${i}`), alias: `F${i}`, neighbor: A("OE1N"), quality: 200 });
    const learned = node.consume(bcast("N", many), A("OE1N"));
    expect(learned).toBeLessThanOrEqual(5); // budget capped this window (neighbour-direct + a few dests)

    t += 61_000; // a fresh window restores the budget
    const more = node.consume(bcast("N", many), A("OE1N"));
    expect(more).toBeGreaterThan(0);
  });
});

describe("hostile-peer OOM guards", () => {
  it("link-app drops the link when 8 KiB arrive with no line terminator", () => {
    let disconnected = false;
    const app: LineApp = { greeting: () => [], handle: () => ({ lines: [] }) };
    const d = makeLineDriver(app, { send: () => {}, disconnect: () => (disconnected = true) });
    d.onData(new TextEncoder().encode("x".repeat(9000))); // no CR/LF
    expect(disconnected).toBe(true);
  });

  it("BBS aborts a send whose body exceeds the ceiling instead of buffering forever", () => {
    const bbs = new BbsSession("OE1USR", {
      listNew: () => [],
      listAll: () => [],
      listBulletins: () => [],
      listMine: () => [],
      read: () => null,
      post: () => 1,
      kill: () => true,
    });
    bbs.handle("SP OE8APR"); // start a personal send
    bbs.handle("subject");
    let aborted = false;
    for (let i = 0; i < 40 && !aborted; i++) {
      const r = bbs.handle("y".repeat(1000)); // 1 KiB/line; the ceiling is 32 KiB
      if (r.lines.join(" ").includes("too large")) aborted = true;
    }
    expect(aborted).toBe(true);
  });

  it("the connect-through sequencer fails a hop that never sends a line break", () => {
    let failed = "";
    const seq = new ConnectSequencer([{ call: "OE8NOD-1" }, { call: "OE9FAR-1" }], {
      send: () => {},
      onReady: () => {},
      onFail: (r) => (failed = r),
    });
    seq.start();
    seq.feed(new TextEncoder().encode("z".repeat(9000))); // no CR/LF from the node
    expect(failed).toMatch(/no line terminator/);
  });

  it("FBB aborts an over-size recv-block", () => {
    const store: FbbStore = {
      outbound: () => [],
      hasBid: () => false,
      accept: () => {
        throw new Error("should not accept an aborted block");
      },
      sent: () => {},
    };
    const s = new FbbSession(store, { initiator: false });
    s.feed("[PEER-1.0-F$]"); // SID → await-proposals
    s.feed("FB P OE8APR WW OE1AAA 1_OE8 5"); // proposal, tiny declared size
    s.feed("F>"); // accept → recv-block
    s.feed("title");
    let out: { out: string[]; done?: boolean } = { out: [] };
    for (let i = 0; i < 20 && !out.done; i++) out = s.feed("q".repeat(500)); // 10 KiB ≫ the 4 KiB floor
    expect(out.done).toBe(true);
    expect(out.out).toContain("FQ");
  });
});

describe("CachedBbsStore never silently discards a write", () => {
  it("retries a failing backend and surfaces the give-up (no silent .catch)", async () => {
    const errors: Array<{ op: string; id: number }> = [];
    const backend: CachedBbsBackend = {
      load: async () => [],
      post: async () => {
        throw new Error("gateway down");
      },
    };
    const store = new CachedBbsStore("OE1USR", backend, {
      maxRetries: 2,
      sleep: async () => {},
      onWriteError: (op, _e, id) => errors.push({ op, id }),
    });
    const id = store.post({ type: "P", from: "OE1USR", to: "OE8APR", subject: "s", body: "b" });
    await ticks();
    expect(store.failedWrites()).toContain(id);
    expect(errors).toEqual([{ op: "post", id }]);
  });

  it("stamps postedAt from the wall clock, not the negative temp id", () => {
    const backend: CachedBbsBackend = { load: async () => [], post: async () => 42 };
    const store = new CachedBbsStore("OE1USR", backend, { clock: () => 1_700_000_000_000 });
    const id = store.post({ type: "P", from: "OE1USR", to: "OE8APR", subject: "s", body: "b" });
    const msg = store.read(id)!;
    expect(msg.postedAt).toBe(1_700_000_000); // seconds, positive
  });
});

describe("FBB loop suppression via a real BID set", () => {
  it("answers hasBid() true for held + about-to-forward BIDs", () => {
    const queued: FbbMessage[] = [
      { type: "P", from: "OE8BBS", at: "WW", to: "DL1ABC", bid: "OUT_1", title: "t", body: "b" },
    ];
    const store = new SessionStore(queued, ["HELD_1", "HELD_2"]);
    expect(store.hasBid("HELD_1")).toBe(true);
    expect(store.hasBid("OUT_1")).toBe(true); // we already hold what we're forwarding
    expect(store.hasBid("UNKNOWN")).toBe(false);
    // accepting a BID marks it held so it isn't re-accepted within the session
    store.accept({ type: "P", from: "X", at: "WW", to: "Y", bid: "NEW_1", title: "t", body: "b" });
    expect(store.hasBid("NEW_1")).toBe(true);
  });
});
