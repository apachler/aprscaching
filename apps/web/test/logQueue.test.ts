// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  backoffMs,
  discardAttention,
  enqueue,
  flush,
  loadAttention,
  loadQueue,
  retryAttention,
  type QueueStore,
  type SendFailure,
} from "../src/log/logQueue.js";
import { syncNote } from "../src/log/syncNote.js";
import type { CacheLogEntry } from "@aprscaching/shared";

const memStore = (): QueueStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};
const T0 = 1_700_000_000_000;
const body = (comment?: string) => ({ logType: "found", comment });
const fails = (f: SendFailure) => () => Promise.reject(f);

describe("the offline log queue", () => {
  it("keeps every log while there is no connection", async () => {
    const s = memStore();
    enqueue(s, { cacheId: 1, body: body() }, T0);
    enqueue(s, { cacheId: 2, body: body() }, T0);
    const r = await flush(s, fails({ kind: "offline" }), T0);
    expect(r).toEqual({ sent: 0, refused: 0 });
    expect(loadQueue(s).map((q) => q.cacheId)).toEqual([1, 2]);
    expect(loadAttention(s)).toEqual([]);
  });

  it("sends what it can and keeps the rest", async () => {
    const s = memStore();
    for (const id of [1, 2, 3]) enqueue(s, { cacheId: id, body: body() }, T0);
    const r = await flush(s, (it) => (it.cacheId === 2 ? Promise.reject({ kind: "retry" }) : Promise.resolve()), T0);
    expect(r.sent).toBe(2);
    expect(loadQueue(s).map((q) => q.cacheId)).toEqual([2]);
  });

  it("moves a refused log to needs-attention with the server's reason, never away", async () => {
    const s = memStore();
    enqueue(s, { cacheId: 7, body: body("hello"), label: "AC-7" }, T0);
    const r = await flush(
      s,
      fails({ kind: "refused", status: 400, reason: "author key not registered to callsign" }),
      T0,
    );
    expect(r.refused).toBe(1);
    expect(loadQueue(s)).toEqual([]);
    expect(loadAttention(s)).toMatchObject([
      { cacheId: 7, label: "AC-7", reason: "author key not registered to callsign", status: 400, refusedAt: T0 },
    ]);
  });

  it("retries a server error with backoff, and not before it is due", async () => {
    const s = memStore();
    enqueue(s, { cacheId: 1, body: body() }, T0);
    const first = await flush(s, fails({ kind: "retry" }), T0);
    expect(first.nextAt).toBe(T0 + backoffMs(1));
    let tried = 0;
    const counting = () => {
      tried++;
      return Promise.reject<void>({ kind: "retry" });
    };
    await flush(s, counting, T0 + backoffMs(1) - 1);
    expect(tried).toBe(0);
    const second = await flush(s, counting, T0 + backoffMs(1));
    expect(tried).toBe(1);
    expect(second.nextAt).toBe(T0 + backoffMs(1) + backoffMs(2));
    expect(loadQueue(s)[0]?.attempts).toBe(2);
  });

  it("backs off from 30 s, doubling, to at most 30 minutes", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([30_000, 60_000, 120_000]);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });

  it("puts a refused log back with an edited comment, or discards it on request", async () => {
    const s = memStore();
    enqueue(s, { cacheId: 1, body: body("old") }, T0);
    enqueue(s, { cacheId: 2, body: body() }, T0);
    await flush(s, fails({ kind: "refused", status: 404, reason: "no such cache" }), T0);
    expect(loadAttention(s)).toHaveLength(2);
    retryAttention(s, 0, T0 + 1, "new");
    expect(loadQueue(s)).toMatchObject([{ cacheId: 1, body: { comment: "new" }, queuedAt: T0 + 1 }]);
    expect(loadQueue(s)[0]).not.toHaveProperty("reason");
    discardAttention(s, 0);
    expect(loadAttention(s)).toEqual([]);
  });

  it("reads a damaged store as empty", () => {
    const s = memStore();
    s.set("acs.logqueue", "{not json");
    expect(loadQueue(s)).toEqual([]);
  });
});

describe("the logbook note on a late log", () => {
  const dt = (ts: number) => `t${ts}`;
  const entry = (p: Partial<CacheLogEntry>): CacheLogEntry =>
    ({
      id: 1,
      cacheId: 1,
      loggerCall: "OE8LOG",
      ts: 1000,
      logType: "found",
      verified: true,
      tier: "A",
      ...p,
    }) as CacheLogEntry;

  it("says nothing for a live log", () => {
    expect(syncNote(entry({ receivedAt: 1010 }), dt)).toBeNull();
    expect(syncNote(entry({}), dt)).toBeNull();
  });
  it("gives both times for a log synced late", () => {
    expect(syncNote(entry({ receivedAt: 1000 + 8 * 3600 }), dt)).toBe(
      `logged offline at t1000, synced t${1000 + 8 * 3600}`,
    );
  });
  it("names why a log counts from its arrival", () => {
    expect(syncNote(entry({ fieldTimeRejected: "unsigned" }), dt)).toBe("logged offline, unsigned · counts from t1000");
    expect(syncNote(entry({ fieldTimeRejected: "before_key" }), dt)).toBe(
      "counts from its arrival: dated before its key was registered",
    );
  });
});
