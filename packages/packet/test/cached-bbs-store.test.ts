import { describe, it, expect } from "vitest";
import { CachedBbsStore, type CachedBbsBackend } from "../src/cached-bbs-store.js";
import type { BbsMsgFull } from "../src/bbs.js";

const snapshot = (): BbsMsgFull[] => [
  { id: 1, type: "B", from: "OE8APR", to: "ALL", subject: "Net", postedAt: 1000, body: "net 144.800", readAt: null },
  { id: 2, type: "P", from: "OE8APR", to: "OE1USR", subject: "hi", postedAt: 1001, body: "welcome", readAt: null },
  { id: 3, type: "P", from: "OE1USR", to: "OE8APR", subject: "re", postedAt: 1002, body: "thanks", readAt: 999 },
];

function fakeBackend(rows: BbsMsgFull[]) {
  const posted: { from: string; to: string; body: string }[] = [];
  const killed: number[] = [];
  const read: number[] = [];
  const backend: CachedBbsBackend = {
    load: async () => rows.map((r) => ({ ...r })),
    post: async (m) => { posted.push({ from: m.from, to: m.to, body: m.body }); return 100 + posted.length; },
    markRead: async (id) => { read.push(id); },
    kill: async (id) => { killed.push(id); },
  };
  return { backend, posted, killed, read };
}

describe("CachedBbsStore (docs/29 F1 — sync store over async gateway)", () => {
  it("serves new / bulletins / mine from the snapshot after refresh", async () => {
    const { backend } = fakeBackend(snapshot());
    const store = new CachedBbsStore("OE1USR", backend);
    await store.refresh();

    expect(store.listNew("OE1USR").map((m) => m.id)).toEqual([1, 2]);  // unread bulletin + unread personal (not #3, already read)
    expect(store.listBulletins().map((m) => m.id)).toEqual([1]);
    expect(store.listMine("OE1USR").map((m) => m.id)).toEqual([2, 3]); // to or from them
    expect(store.listAll()).toHaveLength(3);
  });

  it("read() returns the body, marks unread personal read, and refuses ids outside the snapshot", async () => {
    const { backend, read } = fakeBackend(snapshot());
    const store = new CachedBbsStore("OE1USR", backend);
    await store.refresh();

    expect(store.read(2)!.body).toBe("welcome");
    expect(read).toEqual([2]);                     // fired the async mark-read
    expect(store.listNew("OE1USR").map((m) => m.id)).toEqual([1]); // #2 no longer "new"
    expect(store.read(999)).toBeNull();            // not in the caller's snapshot → not readable
  });

  it("post() is optimistic (visible immediately) and reconciles the real id", async () => {
    const { backend, posted } = fakeBackend(snapshot());
    const store = new CachedBbsStore("OE1USR", backend);
    await store.refresh();

    const tempId = store.post({ type: "P", from: "OE1USR", to: "DL1ABC", subject: "hi", body: "hello" });
    expect(tempId).toBeLessThan(0);                                   // synthetic id
    expect(store.read(tempId)!.body).toBe("hello");                   // visible in-session at once (temp id)
    await Promise.resolve(); await Promise.resolve();                 // let the async post settle
    expect(posted).toEqual([{ from: "OE1USR", to: "DL1ABC", body: "hello" }]);
    expect(store.read(101)!.body).toBe("hello");                      // reconciled to the real server id
    expect(store.read(tempId)).toBeNull();                            // temp id no longer resolves
  });

  it("kill() only removes the caller's own messages", async () => {
    const { backend, killed } = fakeBackend(snapshot());
    const store = new CachedBbsStore("OE1USR", backend);
    await store.refresh();

    expect(store.kill(2, "OE1USR")).toBe(true);     // #2 is to OE1USR → allowed
    expect(store.kill(1, "OE1USR")).toBe(false);    // bulletin from OE8APR to ALL → not theirs, refused
    expect(store.listAll().find((m) => m.id === 2)).toBeUndefined();
    expect(store.listAll().find((m) => m.id === 1)).toBeDefined();
    await Promise.resolve();
    expect(killed).toEqual([2]);
  });
});
