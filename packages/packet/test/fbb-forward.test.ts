// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { FbbForwarder, FBB_MAX_LINE } from "../src/fbb-forward.js";
import { encodeBinaryTransfer } from "../src/fbb-binary.js";
import { fbbCrc16 } from "../src/lzhuf.js";
import { type FbbMessage, type FbbStore } from "../src/fbb-session.js";

/** Same in-memory store as the line-level FBB test, reused at the byte level. */
function makeStore(out: FbbMessage[]): FbbStore & { inbox: FbbMessage[]; queue: FbbMessage[] } {
  const queue = [...out];
  const inbox: FbbMessage[] = [];
  const held = new Set(out.map((m) => m.bid));
  return {
    queue,
    inbox,
    outbound: () => queue,
    hasBid: (bid) => held.has(bid),
    accept: (m) => {
      inbox.push(m);
      held.add(m.bid);
    },
    sent: (bid) => {
      const i = queue.findIndex((m) => m.bid === bid);
      if (i >= 0) queue.splice(i, 1);
    },
  };
}

const msg = (o: Partial<FbbMessage> & Pick<FbbMessage, "from" | "to" | "bid" | "title" | "body">): FbbMessage => ({
  type: "P",
  at: "WW",
  ...o,
});

/** Drive two byte-level forwarders over a deferred byte channel (the re-entrancy-safe loopback pattern). */
function driveBytes(a: FbbForwarder, b: FbbForwarder): void {
  const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [];
  const open = a.start();
  if (open) q.push({ to: "b", bytes: open });
  let guard = 4000;
  while (q.length && guard-- > 0) {
    const { to, bytes } = q.shift()!;
    const out = (to === "a" ? a : b).onData(bytes);
    if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
  }
  if (guard <= 0) throw new Error("byte-level FBB exchange did not terminate");
}

describe("FBB byte-stream forwarder", () => {
  it("forwards a message each way over a raw byte link (CR framing + line buffering)", () => {
    const A = makeStore([
      msg({ from: "OE8BBS", to: "DL1ABC", at: "DB0XYZ", bid: "1_OE8", title: "Hi", body: "hello DL\nline two" }),
    ]);
    const B = makeStore([
      msg({ type: "B", from: "DB0XYZ", to: "ALL", at: "WW", bid: "9_DB0", title: "Net", body: "net on 144.800" }),
    ]);

    const a = new FbbForwarder(A, { initiator: true });
    const b = new FbbForwarder(B, { initiator: false });
    driveBytes(a, b);

    expect(a.done && b.done).toBe(true);
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ from: "OE8BBS", to: "DL1ABC", body: "hello DL\nline two" });
    expect(A.inbox.map((m) => m.bid)).toEqual(["9_DB0"]);
    expect(A.queue).toHaveLength(0);
    expect(B.queue).toHaveLength(0);
  });

  it("forwards a message each way COMPRESSED (LZHUF-B1 blocks) when both SIDs advertise B", () => {
    const bulletin = "APRScaching net tonight on 144.800 MHz.\nAll stations welcome.\n".repeat(30);
    const A = makeStore([
      msg({ from: "OE8BBS", to: "DL1ABC", at: "DB0XYZ", bid: "1_OE8", title: "Hi", body: "hello DL\nline two" }),
    ]);
    const B = makeStore([
      msg({ type: "B", from: "DB0XYZ", to: "ALL", at: "WW", bid: "9_DB0", title: "Net", body: bulletin }),
    ]);

    const a = new FbbForwarder(A, { initiator: true, compress: true });
    const b = new FbbForwarder(B, { initiator: false, compress: true });
    driveBytes(a, b);

    expect(a.done && b.done).toBe(true);
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ from: "OE8BBS", to: "DL1ABC", title: "Hi", body: "hello DL\nline two" });
    expect(A.inbox.map((m) => m.bid)).toEqual(["9_DB0"]);
    expect(A.inbox[0]).toMatchObject({ title: "Net", body: bulletin }); // large body survived compression intact
    expect(A.queue).toHaveLength(0);
    expect(B.queue).toHaveLength(0);
  });

  it("compressed bodies survive being chopped into single bytes on the wire", () => {
    const body = "resume across a byte-by-byte link ".repeat(40);
    const A = makeStore([msg({ type: "B", from: "OE8BBS", to: "ALL", bid: "7_OE8", title: "B", body })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true, compress: true });
    const b = new FbbForwarder(B, { initiator: false, compress: true });

    const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [];
    const open = a.start();
    if (open) q.push({ to: "b", bytes: open });
    let guard = 200000;
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      const target = to === "a" ? a : b;
      let out: Uint8Array | null = null;
      for (const byte of bytes) {
        const r = target.onData(new Uint8Array([byte]));
        if (r) out = out ? new Uint8Array([...out, ...r]) : r;
      }
      if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
    }
    expect(B.inbox.map((m) => m.bid)).toEqual(["7_OE8"]);
    expect(B.inbox[0]).toMatchObject({ body });
  });

  it("falls back to ASCII when only one side advertises compression", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Hi", body: "plain body" })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true, compress: true }); // A offers B
    const b = new FbbForwarder(B, { initiator: false }); // B does not
    driveBytes(a, b);
    expect(B.inbox[0]).toMatchObject({ bid: "1_OE8", body: "plain body" });
  });

  it("tolerates frames split across arbitrary byte boundaries", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Hi", body: "one liner" })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true });
    const b = new FbbForwarder(B, { initiator: false });

    // feed 'a' as normal but chop every chunk 'b' would receive into single bytes
    const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [];
    const open = a.start();
    if (open) q.push({ to: "b", bytes: open });
    let guard = 8000;
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      const target = to === "a" ? a : b;
      let out: Uint8Array | null = null;
      for (const byte of bytes) {
        const r = target.onData(new Uint8Array([byte]));
        if (r) out = out ? new Uint8Array([...out, ...r]) : r;
      }
      if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
    }
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(B.inbox[0]).toMatchObject({ body: "one liner" });
  });

  it("ends the session with FQ when a line runs past the line ceiling", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : "");
    const partial = new FbbForwarder(makeStore([]), { initiator: false });
    expect(partial.onData(enc("x".repeat(FBB_MAX_LINE)))).toBeNull(); // at the ceiling: still buffered
    expect(partial.done).toBe(false);
    expect(dec(partial.onData(enc("x")))).toBe("FQ\r");
    expect(partial.done && partial.aborted).toBe(true);
    expect(partial.onData(enc("[FBB-7.0-AFHM$]\r"))).toBeNull(); // nothing after the end

    const whole = new FbbForwarder(makeStore([]), { initiator: false });
    expect(dec(whole.onData(enc("y".repeat(FBB_MAX_LINE + 1) + "\r")))).toBe("FQ\r");
    expect(whole.aborted).toBe(true);
  });

  it("keeps a long trickle of partial-line bytes bounded and still reads the line when it ends", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Hi", body: "trickle" })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true });
    const b = new FbbForwarder(B, { initiator: false });
    const open = a.start()!;
    // a long run of blank separators arrives byte by byte ahead of the SID, then the real exchange
    for (let i = 0; i < 4000; i++) b.onData(new Uint8Array([0x0a]));
    const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [{ to: "b", bytes: open }];
    let guard = 4000;
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      const out = (to === "a" ? a : b).onData(bytes);
      if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
    }
    expect(B.inbox.map((m) => m.bid)).toEqual(["1_OE8"]);
    expect(b.aborted).toBe(false);
  });

  it("ends the session with FQ, storing nothing, when a compressed body cannot be decompressed", () => {
    const A = makeStore([msg({ from: "OE8BBS", to: "DL1ABC", bid: "1_OE8", title: "Hi", body: "hello" })]);
    const B = makeStore([]);
    const a = new FbbForwarder(A, { initiator: true, compress: true });
    const b = new FbbForwarder(B, { initiator: false, compress: true });
    // a B1 stream with a valid CRC whose declared size is far above the receive ceiling
    const sizeAndStream = new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x12, 0x34]);
    const crc = fbbCrc16(sizeAndStream);
    const b1 = new Uint8Array([crc & 0xff, crc >> 8, ...sizeAndStream]);
    const header = new TextEncoder().encode("Hi\x000\x00");
    const session = (a as unknown as { session: { takeBinary(): Uint8Array[] } }).session;
    const take = session.takeBinary.bind(session);
    session.takeBinary = () => take().map(() => encodeBinaryTransfer(header, b1));

    const sentByB: string[] = [];
    const q: Array<{ to: "a" | "b"; bytes: Uint8Array }> = [{ to: "b", bytes: a.start()! }];
    let guard = 4000;
    while (q.length && guard-- > 0) {
      const { to, bytes } = q.shift()!;
      const out = (to === "a" ? a : b).onData(bytes);
      if (out && to === "b") sentByB.push(new TextDecoder("latin1").decode(out));
      if (out) q.push({ to: to === "a" ? "b" : "a", bytes: out });
    }
    expect(B.inbox).toEqual([]);
    expect(b.done && b.aborted).toBe(true);
    expect(sentByB.at(-1)).toBe("FQ\r");
  });
});
