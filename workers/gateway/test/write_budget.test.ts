// SPDX-License-Identifier: AGPL-3.0-or-later
// The daily D1 write budget: the counter the live room keeps (levels, the 00:00 UTC reset, one alert
// per threshold per day, at most one storage write a minute), the setting's defaults per runtime, and
// the room endpoints the gateway reaches it through.
import { describe, it, expect } from "vitest";
import {
  BudgetCounter,
  applyWorkerDefaults,
  rowsWritten,
  writeBudget,
  type BudgetState,
  type BudgetStore,
} from "../src/budget.js";
import { stringEnvFrom, type Env } from "../src/env.js";
import { RegionRoom } from "../src/room.js";

const env = (o: Record<string, string>) => o as unknown as Env;

/** A store that counts its writes, as Durable Object storage bills them. */
function countingStore(initial?: BudgetState): BudgetStore & { saves: number; saved?: BudgetState } {
  const s: BudgetStore & { saves: number; saved?: BudgetState } = {
    saves: 0,
    saved: initial,
    async load() {
      return s.saved ? structuredClone(s.saved) : undefined;
    },
    async save(state) {
      s.saves++;
      s.saved = structuredClone(state);
    },
  };
  return s;
}

/** A fake clock, in milliseconds. */
function clock(start: string) {
  let t = Date.parse(start);
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("D1_DAILY_WRITE_BUDGET", () => {
  it("defaults to 1,500,000 rows a day on the Worker", () => {
    expect(writeBudget(applyWorkerDefaults(env({})))).toBe(1_500_000);
    expect(writeBudget(applyWorkerDefaults(env({ D1_DAILY_WRITE_BUDGET: " " })))).toBe(1_500_000);
    expect(writeBudget(applyWorkerDefaults(env({ D1_DAILY_WRITE_BUDGET: "90000" })))).toBe(90_000);
  });

  it("0 turns the guard off on the Worker", () => {
    expect(writeBudget(applyWorkerDefaults(env({ D1_DAILY_WRITE_BUDGET: "0" })))).toBe(0);
  });

  it("is off on Node and Bun unless it is set", () => {
    // the self-host servers build their env from the process environment and never apply the Worker default
    expect(writeBudget(stringEnvFrom({}) as Env)).toBe(0);
    expect(writeBudget(stringEnvFrom({ D1_DAILY_WRITE_BUDGET: "50000" }) as Env)).toBe(50_000);
  });

  it("ignores a value that is not a non-negative number", () => {
    expect(writeBudget(env({ D1_DAILY_WRITE_BUDGET: "lots" }))).toBe(0);
    expect(writeBudget(env({ D1_DAILY_WRITE_BUDGET: "-5" }))).toBe(0);
    expect(writeBudget(applyWorkerDefaults(env({ D1_DAILY_WRITE_BUDGET: "lots" })))).toBe(1_500_000);
  });
});

describe("rows written by one D1 result", () => {
  it("is D1's rows_written, and a runtime without it reports changes", () => {
    expect(rowsWritten({ rows_written: 4, changes: 1 })).toBe(4);
    expect(rowsWritten({ rows_written: 0, changes: 0 })).toBe(0); // a read
    expect(rowsWritten({ changes: 3 })).toBe(3); // the Node/Bun SQLite shim
    expect(rowsWritten({})).toBe(0);
    expect(rowsWritten(undefined)).toBe(0);
  });
});

describe("the budget counter", () => {
  it("reports the level: ok below 80 %, warn from 80 %, over from 100 %, off without a budget", async () => {
    const c = clock("2026-09-30T10:00:00Z");
    const counter = new BudgetCounter(countingStore(), c.now);
    expect((await counter.add(799, 1000)).level).toBe("ok");
    expect((await counter.add(1, 1000)).level).toBe("warn");
    expect((await counter.add(199, 1000)).level).toBe("warn");
    const v = await counter.add(1, 1000);
    expect(v).toMatchObject({ used: 1000, budget: 1000, level: "over", day: "2026-09-30" });
    expect((await counter.view(0)).level).toBe("off");
  });

  it("starts from zero at 00:00 UTC", async () => {
    const c = clock("2026-09-30T23:59:00Z");
    const counter = new BudgetCounter(countingStore(), c.now);
    expect((await counter.add(1200, 1000)).level).toBe("over");
    c.advance(59_000); // 23:59:59
    expect((await counter.view(1000)).used).toBe(1200);
    c.advance(1_000); // 00:00:00
    const v = await counter.view(1000);
    expect(v).toMatchObject({ used: 0, level: "ok", day: "2026-10-01" });
    expect((await counter.add(5, 1000)).used).toBe(5);
  });

  it("writes its storage at most once a minute however many writes it counts", async () => {
    const c = clock("2026-09-30T08:00:00Z");
    const store = countingStore();
    const counter = new BudgetCounter(store, c.now);
    // two hours of ingest batches every 360 ms, well under the budget (no alert forces a save)
    const adds = (2 * 3600 * 1000) / 360;
    for (let i = 0; i < adds; i++) {
      await counter.add(3, 10_000_000);
      c.advance(360);
    }
    expect(store.saves).toBeGreaterThan(0);
    expect(store.saves).toBeLessThanOrEqual(2 * 60 + 1);
    expect(store.saved!.used).toBeGreaterThan(0);
  });

  it("restores the persisted count when the object starts again", async () => {
    const c = clock("2026-09-30T08:00:00Z");
    const store = countingStore();
    const first = new BudgetCounter(store, c.now);
    await first.add(400, 1000);
    c.advance(61_000);
    await first.add(100, 1000); // a minute on: persisted
    const again = new BudgetCounter(store, c.now);
    expect((await again.view(1000)).used).toBe(500);
    // a stored count from an earlier day is not today's
    c.advance(24 * 3600 * 1000);
    expect((await new BudgetCounter(store, c.now).view(1000)).used).toBe(0);
  });

  it("does not lose a count to two requests racing the first load", async () => {
    const counter = new BudgetCounter(countingStore(), clock("2026-09-30T08:00:00Z").now);
    await Promise.all([counter.add(2, 100), counter.add(3, 100)]);
    expect((await counter.view(100)).used).toBe(5);
  });

  it("raises one alert per threshold per UTC day, persisted at once", async () => {
    const c = clock("2026-09-30T10:00:00Z");
    const store = countingStore();
    const counter = new BudgetCounter(store, c.now);
    await counter.add(10, 1000);
    const savesBefore = store.saves;
    await counter.add(800, 1000); // crosses 80 %
    expect(store.saves).toBe(savesBefore + 1);
    await counter.add(50, 1000);
    await counter.add(300, 1000); // crosses 100 %
    await counter.add(300, 1000);
    const v = await counter.view(1000);
    expect(v.alerts.map((a) => [a.day, a.threshold, a.mailed])).toEqual([
      ["2026-09-30", 80, false],
      ["2026-09-30", 100, false],
    ]);
    expect(store.saved!.alerts).toHaveLength(2);
    // the next day raises its own alerts; the previous day's stay listed until mailed
    c.advance(24 * 3600 * 1000);
    const next = await counter.add(900, 1000);
    expect(next.alerts.map((a) => `${a.day}/${a.threshold}`)).toEqual([
      "2026-09-30/80",
      "2026-09-30/100",
      "2026-10-01/80",
    ]);
    await counter.markMailed(["2026-09-30/80", "2026-09-30/100"]);
    // a mailed alert of an earlier day is no longer listed; today's are, mailed or not
    await counter.markMailed(["2026-10-01/80"]);
    expect((await counter.view(1000)).alerts.map((a) => `${a.day}/${a.threshold}/${a.mailed}`)).toEqual([
      "2026-10-01/80/true",
    ]);
    // two days on, the old alerts are gone
    c.advance(2 * 24 * 3600 * 1000);
    expect((await counter.view(1000)).alerts).toEqual([]);
  });

  it("raises no alert without a budget", async () => {
    const counter = new BudgetCounter(countingStore(), clock("2026-09-30T10:00:00Z").now);
    await counter.add(1_000_000, 0);
    expect((await counter.view(0)).alerts).toEqual([]);
  });
});

/** A fake DurableObjectState: storage over a Map and no WebSockets. */
function fakeState() {
  const kv = new Map<string, unknown>();
  let puts = 0;
  const ctx = {
    storage: {
      get: async (k: string) => structuredClone(kv.get(k)),
      put: async (k: string, v: unknown) => {
        puts++;
        kv.set(k, structuredClone(v));
      },
    },
    getWebSockets: () => [],
  };
  return { ctx: ctx as unknown as DurableObjectState, puts: () => puts, kv };
}

describe("the live room keeps the budget", () => {
  const post = (path: string, body: unknown) =>
    new Request(`https://room${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("adds the batch's writes with the live dispatch and answers the level", async () => {
    const s = fakeState();
    const room = new RegionRoom(s.ctx, {} as Env);
    const r = await room.fetch(post("/dispatch", { envelopes: [], budget: { add: 900, limit: 1000 } }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ used: 900, budget: 1000, level: "warn" });
    const g = await room.fetch(new Request("https://room/budget?limit=1000"));
    expect(await g.json()).toMatchObject({ used: 900, level: "warn" });
    const p = await room.fetch(post("/budget", { add: 200, limit: 1000 }));
    expect(await p.json()).toMatchObject({ used: 1100, level: "over" });
    // a dispatch without a budget part answers as before
    expect((await room.fetch(post("/dispatch", { envelopes: [] }))).status).toBe(204);
    expect(s.puts()).toBeGreaterThan(0);
  });

  it("restores the count from its storage after a restart", async () => {
    const s = fakeState();
    await new RegionRoom(s.ctx, {} as Env).fetch(post("/budget", { add: 42, limit: 1000 }));
    const again = new RegionRoom(s.ctx, {} as Env);
    const g = await again.fetch(new Request("https://room/budget?limit=1000"));
    expect(await g.json()).toMatchObject({ used: 42 });
  });

  it("refuses a public request that is not a WebSocket upgrade", async () => {
    // /ws forwards the client's own request: a POST there must neither broadcast nor count
    const s = fakeState();
    const room = new RegionRoom(s.ctx, {} as Env);
    const r = await room.fetch(post("/ws?region=global", { envelopes: [], budget: { add: 1e9, limit: 1000 } }));
    expect(r.status).toBe(426);
    const g = await room.fetch(new Request("https://room/budget?limit=1000"));
    expect(await g.json()).toMatchObject({ used: 0 });
  });

  it("rejects a malformed add", async () => {
    const room = new RegionRoom(fakeState().ctx, {} as Env);
    expect((await room.fetch(post("/budget", { add: -5, limit: 1000 }))).status).toBe(400);
    expect((await room.fetch(post("/budget", { add: "x", limit: 1000 }))).status).toBe(400);
  });
});
