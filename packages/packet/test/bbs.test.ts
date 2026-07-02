// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { BbsSession, type MessageStore, type BbsMsgFull } from "../src/index.js";

/** A tiny in-memory message base for driving the interpreter. */
function makeStore(): MessageStore & { msgs: BbsMsgFull[] } {
  const msgs: BbsMsgFull[] = [];
  let id = 0;
  return {
    msgs,
    listNew: (call) => msgs.filter((m) => m.type !== "P" || m.to === call),
    listAll: () => [...msgs].reverse(),
    listBulletins: () => msgs.filter((m) => m.type === "B"),
    listMine: (call) => msgs.filter((m) => m.to === call || m.from === call),
    read: (i) => msgs.find((m) => m.id === i) ?? null,
    post: (m) => { const nid = ++id; msgs.push({ id: nid, postedAt: 0, ...m }); return nid; },
    kill: (i, call) => { const idx = msgs.findIndex((m) => m.id === i && (m.from === call || m.to === call)); if (idx < 0) return false; msgs.splice(idx, 1); return true; },
  };
}

/** Feed a sequence of lines, return all output lines flattened. */
function run(s: BbsSession, lines: string[]): { out: string[]; disconnected: boolean } {
  const out: string[] = []; let disconnected = false;
  for (const l of lines) { const r = s.handle(l); out.push(...r.lines); if (r.disconnect) disconnected = true; }
  return { out, disconnected };
}

describe("FBB BBS command interpreter (docs/design/25 P2)", () => {
  it("greets with the new-message count and a prompt", () => {
    const s = new BbsSession("OE8APR", makeStore(), "OE8BBS");
    const g = s.greeting();
    expect(g[0]).toMatch(/APRScaching BBS OE8BBS/);
    expect(g.at(-1)).toBe("OE8APR de OE8BBS>");
  });

  it("sends a personal message via S → Subject → body → /EX, then lists + reads it", () => {
    const store = makeStore();
    const s = new BbsSession("OE8APR", store, "OE8BBS");
    run(s, ["SP OE8XBM", "Hello there", "first line", "second line", "/EX"]);
    expect(store.msgs).toHaveLength(1);
    expect(store.msgs[0]).toMatchObject({ type: "P", from: "OE8APR", to: "OE8XBM", subject: "Hello there", body: "first line\nsecond line" });

    const xbm = new BbsSession("OE8XBM", store, "OE8BBS");
    const list = run(xbm, ["L"]).out;
    expect(list.some((l) => /Hello there/.test(l))).toBe(true);
    const read = run(xbm, ["R 1"]).out;
    expect(read.some((l) => l === "first line")).toBe(true);
  });

  it("SR replies into the same thread with a Re: subject addressed back to the sender", () => {
    const store = makeStore();
    new BbsSession("OE8APR", store, "OE8BBS").handle("dummy"); // no-op
    const a = new BbsSession("OE8APR", store, "OE8BBS");
    run(a, ["SP OE8XBM", "Question", "are you there?", "."]);
    const b = new BbsSession("OE8XBM", store, "OE8BBS");
    run(b, ["R 1", "SR", "yes I am", "/EX"]);
    const reply = store.msgs[1]!;
    expect(reply).toMatchObject({ from: "OE8XBM", to: "OE8APR", subject: "Re: Question", replyTo: 1 });
  });

  it("typing: SB makes a bulletin, ST makes traffic; LB lists only bulletins", () => {
    const store = makeStore();
    const s = new BbsSession("OE8APR", store, "OE8BBS");
    run(s, ["SB ALL", "Net tonight", "2000z on .550", "/EX"]);
    run(s, ["ST OE3XYZ", "QTC", "msg 1", "/EX"]);
    expect(store.msgs.map((m) => m.type)).toEqual(["B", "T"]);
    expect(run(s, ["LB"]).out.some((l) => /Net tonight/.test(l))).toBe(true);
  });

  it("K kills only your own; B disconnects; X toggles expert prompt", () => {
    const store = makeStore();
    const s = new BbsSession("OE8APR", store, "OE8BBS");
    run(s, ["SP OE8APR", "self", "x", "/EX"]);
    expect(run(s, ["K 1"]).out.some((l) => /killed/.test(l))).toBe(true);
    expect(run(s, ["K 99"]).out.some((l) => /Can't kill/.test(l))).toBe(true);
    const x = s.handle("X");
    expect(x.lines.at(-1)).toBe(">");          // expert prompt
    expect(run(s, ["B"]).disconnected).toBe(true);
  });

  it("H lists help; unknown commands are reported", () => {
    const s = new BbsSession("OE8APR", makeStore(), "OE8BBS");
    expect(s.handle("H").lines.some((l) => /Commands:/.test(l))).toBe(true);
    expect(s.handle("ZZ").lines.some((l) => /Unknown command/.test(l))).toBe(true);
  });
});
