// SPDX-License-Identifier: MIT
// A connected-mode caller is unauthenticated and controls how fast the link drains, so nothing it sends may
// grow the box's memory without bound or ask for an unbounded reply: replies wait behind the link's backlog,
// the link refuses data past its queue cap, every I-frame fits paclen, a BBS read never throws, and an FBB
// responder session takes at most five proposals a block from a configured partner only.
import { describe, it, expect } from "vitest";
import type { Ax25Frame } from "@aprscaching/ax25";
import {
  BbsSession,
  FbbGatedBbs,
  SessionStore,
  makeLineDriver,
  serveApp,
  type BbsMsgFull,
  type LineApp,
  type MessageStore,
} from "../src/index.js";

const local = { call: "BBS", ssid: 0 };
const remote = { call: "EVIL", ssid: 1 };
const enc = (s: string) => new TextEncoder().encode(s);

function storeWith(msgs: BbsMsgFull[]): MessageStore {
  return {
    listNew: () => [],
    listAll: () => msgs,
    listBulletins: () => msgs,
    listMine: () => [],
    read: (id) => msgs.find((m) => m.id === id) ?? null,
    post: () => 1,
    kill: () => false,
  };
}
const bulletin = (id: number, body: string): BbsMsgFull => ({
  id,
  type: "B",
  from: "N0ONE",
  to: "ALL",
  subject: "s",
  postedAt: 0,
  body,
});

/** A BBS session on a server link, with every transmitted frame recorded. */
function bbsLink(msgs: BbsMsgFull[]) {
  let clock = 0;
  const sent: Ax25Frame[] = [];
  const states: string[] = [];
  const link = serveApp(local, remote, new BbsSession("EVIL-1", storeWith(msgs), "BBS"), {
    send: (f) => sent.push(f),
    clock: () => clock,
    onState: (s) => states.push(s),
  });
  const rx = (f: Partial<Ax25Frame>) => link.onReceive({ dst: local, src: remote, ...f } as Ax25Frame);
  rx({ command: true, type: "SABM", pf: true });
  return { link, sent, states, rx, tick: (ms: number) => (clock += ms) };
}

describe("connected-mode link bounds", () => {
  it("queues no more replies while the caller holds the link busy, and drops a caller that keeps sending", () => {
    const { link, states, rx, tick } = bbsLink([]);
    rx({ command: false, type: "RNR", pf: false, nr: 0 });
    const info = enc("H\r".repeat(250));
    let ns = 0;
    for (let i = 0; i < 2000 && link.state !== "disconnected"; i++) {
      rx({ command: true, type: "I", pf: false, ns, nr: 0, pid: 0xf0, info });
      ns = (ns + 1) % 8;
      if (i % 50 === 0) {
        tick(31_000);
        link.poll();
        rx({ command: false, type: "RNR", pf: true, nr: 0 });
      }
    }
    const queued = (link as unknown as { pending: { info: Uint8Array }[] }).pending;
    expect(queued.reduce((n, p) => n + p.info.length, 0)).toBeLessThan(16 * 1024);
    expect(states).toContain("disconnecting");
  });

  it("sends a long reply as I-frames of at most paclen bytes", () => {
    const { sent, rx } = bbsLink([bulletin(1234, ("X".repeat(79) + "\n").repeat(400))]);
    sent.length = 0;
    rx({ command: true, type: "I", pf: false, ns: 0, nr: 0, pid: 0xf0, info: enc("R" + " 1234".repeat(100) + "\r") });
    const iFrames = sent.filter((f) => f.type === "I");
    expect(iFrames.length).toBeGreaterThan(0);
    expect(Math.max(...iFrames.map((f) => f.info?.length ?? 0))).toBeLessThanOrEqual(256);
  });

  it("reads a body of many empty lines, several times over, without throwing", () => {
    const { rx } = bbsLink([bulletin(1234, "\n".repeat(32_000))]);
    expect(() =>
      rx({ command: true, type: "I", pf: false, ns: 0, nr: 0, pid: 0xf0, info: enc("R" + " 1234".repeat(5) + "\r") }),
    ).not.toThrow();
  });

  it("reads at most five messages and a bounded reply per R", () => {
    const body = "Y".repeat(40_000);
    const s = new BbsSession("EVIL-1", storeWith([bulletin(1, body), bulletin(2, body), bulletin(3, "short")]), "BBS");
    const r = s.handle("R 1 2 3 1 2 3 1");
    const text = r.lines.join("\n");
    expect(text).toContain("first 5 of 7");
    expect(text).toContain("Message 2 not shown");
    expect(text.length).toBeLessThan(2 * body.length);
    expect(text).toContain("short");
  });

  it("tears the link down when data would take its send queue past the cap", () => {
    const { link, rx, states } = bbsLink([]);
    rx({ command: false, type: "RNR", pf: false, nr: 0 });
    expect(link.send(new Uint8Array(400 * 1024))).toBe(true);
    expect(link.send(new Uint8Array(200 * 1024))).toBe(false);
    expect(link.backlog).toBe(0);
    expect(states).toContain("disconnecting");
  });
});

describe("FBB responder bounds", () => {
  const interactive: LineApp = { greeting: () => [], handle: () => ({ lines: [] }) };

  async function drive(isPartner: boolean, lines: string[]) {
    const gate = new FbbGatedBbs(interactive, {
      isPartner: () => isPartner,
      makeStore: () => new SessionStore([], []),
    });
    let disc = 0;
    const out: string[] = [];
    const drv = makeLineDriver(gate, {
      send: (b) => out.push(new TextDecoder().decode(b)),
      disconnect: () => {
        disc++;
      },
    });
    drv.onUp();
    for (const l of lines) {
      drv.onData(enc(l + "\r"));
      await new Promise((r) => setTimeout(r, 0));
      if (disc) break;
    }
    return { gate, disc, out: out.join("") };
  }

  it("ends the session at the sixth proposal of a block", async () => {
    const fb = Array.from({ length: 2000 }, (_, i) => `FB P A B C ${"B".repeat(1000)}${i} 1`);
    const { gate, disc, out } = await drive(true, ["[EVIL-1.0-F$]", ...fb]);
    expect((gate as unknown as { fbb: { accepting: unknown[] } }).fbb.accepting.length).toBeLessThanOrEqual(5);
    expect(disc).toBe(1);
    expect(out).toContain("FQ");
  });

  it("defers proposals past the session's receive budget", async () => {
    const block = (b: number) => [
      ...Array.from({ length: 5 }, (_, i) => `FB P A B C BID${b}_${i} 60000`),
      "F>",
      // the five bodies, each title / one line / ^Z
      ...Array.from({ length: 5 }, () => ["t", "x", "\x1a"]).flat(),
    ];
    const lines = ["[EVIL-1.0-F$]", ...[0, 1, 2, 3].flatMap(block)];
    const { out } = await drive(true, lines);
    const verdicts = [...out.matchAll(/FS ([+\-=]+)/g)].map((m) => m[1]).join("");
    expect(verdicts.startsWith("+++++")).toBe(true);
    expect(verdicts).toContain("=");
    expect(verdicts.split("").filter((v) => v === "+").length).toBeLessThanOrEqual(16);
  });

  it("accepts at most 100 messages in one session and defers the rest", async () => {
    const block = (b: number) => [
      ...Array.from({ length: 5 }, (_, i) => `FB P A B C BID${b}_${i} 1`),
      "F>",
      ...Array.from({ length: 5 }, () => ["t", "x", "\x1a"]).flat(),
    ];
    const lines = ["[EVIL-1.0-F$]", ...Array.from({ length: 21 }, (_, b) => block(b)).flat()];
    const { out } = await drive(true, lines);
    const verdicts = [...out.matchAll(/FS ([+\-=]+)/g)].map((m) => m[1]).join("");
    expect(verdicts).toBe("+".repeat(100) + "=".repeat(5));
  });

  it("answers no line a non-partner buffered behind its SID", async () => {
    const handled: string[] = [];
    const menu: LineApp = { greeting: () => [], handle: (l) => (handled.push(l), { lines: ["menu: " + l] }) };
    const gate = new FbbGatedBbs(menu, { isPartner: async () => false, makeStore: () => new SessionStore([], []) });
    const out: string[] = [];
    let disc = 0;
    const drv = makeLineDriver(gate, {
      send: (b) => out.push(new TextDecoder().decode(b)),
      disconnect: () => {
        disc++;
      },
    });
    drv.onUp();
    drv.onData(enc("[EVIL-1.0-F$]\rH\rL\r"));
    await new Promise((r) => setTimeout(r, 0));
    expect(out.join("")).toContain("Not a forwarding partner");
    expect(handled).toEqual([]);
    expect(disc).toBe(1);
  });

  it("disconnects a caller that answers with a SID but is no forwarding partner", async () => {
    const { gate, disc, out } = await drive(false, ["[EVIL-1.0-F$]", "FB P A B C X1 1", "F>"]);
    expect(disc).toBe(1);
    expect(out).toContain("Not a forwarding partner");
    expect((gate as unknown as { fbb: unknown }).fbb).toBeNull();
  });
});

describe("line driver", () => {
  it("answers no line buffered behind an async reply that disconnects, on the air or off it", async () => {
    const handled: string[] = [];
    const app: LineApp = {
      greeting: () => [],
      handle: (l) => {
        handled.push(l);
        if (l === "A") return Promise.resolve({ lines: ["bye"], disconnect: true });
        return { lines: ["reply to " + l] };
      },
    };
    const sent: Ax25Frame[] = [];
    const link = serveApp(local, remote, app, { send: (f) => sent.push(f), clock: () => 0 });
    const rx = (f: Partial<Ax25Frame>) => link.onReceive({ dst: local, src: remote, ...f } as Ax25Frame);
    rx({ command: true, type: "SABM", pf: true });
    rx({ command: true, type: "I", pf: false, ns: 0, nr: 0, pid: 0xf0, info: enc("A\rB\rC\r") });
    await new Promise((r) => setTimeout(r, 0));
    expect(handled).toEqual(["A"]);
    const text = sent.map((f) => (f.info ? new TextDecoder().decode(f.info) : "")).join("");
    expect(text).toContain("bye");
    expect(text).not.toContain("reply to");
    expect(sent.at(-1)?.type).toBe("DISC");
  });
});
