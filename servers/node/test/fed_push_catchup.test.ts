// SPDX-License-Identifier: AGPL-3.0-or-later
// Push-to-hub catch-up: a spoke resumes from persisted cursors instead of pushing its history again, a
// failed page never advances them, and the hub's marks put a restored spoke or a restored hub back where
// the hub actually stands. After a network failure the spoke probes the hub with backoff and syncs the
// moment it answers; both sides show how pushing stands.
import { describe, it, expect } from "vitest";
import { pushToHub } from "@aprscaching/gateway/fedpush";
import { catchUp, probeDelayMs } from "@aprscaching/gateway/fedcatchup";
import { newFedKey, instanceEnv, addCache, serve, type Serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "submit-secret";
const OP = { "x-operator-secret": "test-operator-secret" };
let hubSeq = 0;

/** A hub and a spoke with `caches` native caches; `fetch` routes the spoke's requests to the hub. */
async function pair(caches = 3) {
  const hubUrl = `https://hub${++hubSeq}.example`;
  const hub = instanceEnv("hub.example", await newFedKey(), { FED_SUBMIT_SECRET: SECRET }) as unknown as Env;
  const spoke = instanceEnv("s.example", await newFedKey(), {
    FED_HUB_URL: hubUrl,
    FED_SUBMIT_SECRET: SECRET,
  }) as unknown as Env;
  for (let i = 0; i < caches; i++) await addCache(spoke, 1000 + i);
  const submits: string[] = [];
  let down = false;
  const toHub: Serve = (req) => serve(hub)(req);
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (down) throw new TypeError("fetch failed");
    const req = new Request(url, init);
    if (new URL(url).pathname === "/federation/submit") submits.push(url);
    return toHub(req);
  };
  return {
    hub,
    spoke,
    hubUrl,
    submits,
    fetchFn,
    setDown: (v: boolean) => {
      down = v;
    },
  };
}
const mirrored = async (hub: Env) =>
  (await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n ?? 0;
const cursorRows = async (spoke: Env) =>
  (await spoke.DB.prepare("SELECT type, cursor FROM fed_push_cursors ORDER BY type").all()).results;

describe("persisted push cursors", () => {
  it("resumes after a restart without pushing again", async () => {
    const t = await pair();
    expect((await pushToHub(t.spoke, t.fetchFn))?.pushed).toBeGreaterThanOrEqual(3);
    expect(await mirrored(t.hub)).toBe(3);
    const before = t.submits.length;
    // a restarted process reads the hub's marks again and finds nothing to send
    const again = await pushToHub(t.spoke, t.fetchFn, { resync: true });
    expect(again).toMatchObject({ pushed: 0, backlog: false });
    expect(t.submits.length).toBe(before);
  });

  it("does not advance when the hub fails mid-push, and records the outage", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn); // reads the marks once
    await addCache(t.spoke, 5000);
    t.setDown(true);
    const failed = await pushToHub(t.spoke, t.fetchFn);
    expect(failed?.failure).toBe("network");
    const st = await t.spoke.DB.prepare("SELECT offline_since, last_ok_at FROM fed_hub_status WHERE hub = ?")
      .bind(t.hubUrl)
      .first<{ offline_since: number | null }>();
    expect(st?.offline_since).toBeTypeOf("number");
    t.setDown(false);
    const ok = await pushToHub(t.spoke, t.fetchFn);
    expect(ok?.failure).toBeUndefined();
    expect(await mirrored(t.hub)).toBe(4);
    const after = await t.spoke.DB.prepare("SELECT offline_since FROM fed_hub_status WHERE hub = ?")
      .bind(t.hubUrl)
      .first<{ offline_since: number | null }>();
    expect(after?.offline_since).toBeNull();
  });

  it("treats a gateway reporting the hub down as offline, and a refusal as refused", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn);
    await addCache(t.spoke, 6000);
    const answering = (status: number) => async () => new Response("x", { status });
    expect((await pushToHub(t.spoke, answering(503)))?.failure).toBe("network");
    expect((await pushToHub(t.spoke, answering(403)))?.failure).toBe("refused");
  });
});

describe("the hub's marks", () => {
  it("a spoke restored from a backup skips what the hub already has", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn);
    await t.spoke.DB.prepare("DELETE FROM fed_push_cursors").run(); // the restored database predates the push
    const before = t.submits.length;
    const r = await pushToHub(t.spoke, t.fetchFn, { resync: true });
    expect(r?.pushed).toBe(0);
    expect(t.submits.length).toBe(before);
    expect((await cursorRows(t.spoke)).length).toBeGreaterThan(0);
  });

  it("a hub restored from a backup gets back what it lost", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn);
    // a restore rolls back the mirror, its applied versions and the marks together
    for (const table of ["remote_caches", "fed_versions", "fed_submit_marks"])
      await t.hub.DB.prepare(`DELETE FROM ${table}`).run();
    expect(await mirrored(t.hub)).toBe(0);
    await pushToHub(t.spoke, t.fetchFn, { resync: true }); // read again after the outage
    expect(await mirrored(t.hub)).toBe(3);
  });

  it("are read only by the spoke itself, signed with its key", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn);
    const plain = await serve(t.hub)(
      new Request("https://hub.example/federation/submit/marks", {
        headers: { "x-fed-secret": SECRET, "x-relay-instance": "s.example", "x-relay-at": "1", "x-relay-sig": "x" },
      }),
    );
    expect(plain.status).toBe(401);
    const res = await serve(t.hub)(
      new Request("https://hub.example/federation/submit/marks", { headers: { "x-fed-secret": "wrong" } }),
    );
    expect(res.status).toBe(401);
  });
});

describe("reconnect probe", () => {
  it("backs off from 30 s to at most 10 minutes, with jitter", () => {
    const mid = () => 0.5;
    expect([0, 1, 2].map((a) => probeDelayMs(a, mid))).toEqual([30_000, 60_000, 120_000]);
    expect(probeDelayMs(30, mid)).toBe(600_000);
    expect(probeDelayMs(0, () => 0)).toBe(24_000);
    expect(probeDelayMs(0, () => 1)).toBe(36_000);
  });

  it("probes after a network failure and syncs with the hub's marks the moment it answers", async () => {
    const queue: { fn: () => void; ms: number }[] = [];
    const syncs: { resync?: boolean }[] = [];
    const probes = [false, false, true];
    const results = [{ push: { pushed: 0, backlog: false, failure: "network" as const } }, { push: null }];
    const loop = catchUp({} as Env, {
      timers: { setTimeout: (fn, ms) => queue.push({ fn, ms }), clearTimeout: () => {} },
      sync: (opts) => {
        syncs.push(opts);
        return Promise.resolve(results.shift() ?? { push: null });
      },
      probe: () => Promise.resolve(probes.shift() ?? false),
      rand: () => 0.5,
    });
    await loop.run();
    const step = async () => {
      const next = queue.shift()!;
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
      return next.ms;
    };
    expect(await step()).toBe(30_000); // first probe: no answer
    expect(await step()).toBe(60_000); // second: no answer
    expect(await step()).toBe(120_000); // third answers → sync now, re-reading the marks
    expect(syncs).toEqual([{}, { resync: true }]);
    expect(queue).toHaveLength(0);
  });

  it("runs again soon while a backlog remains", async () => {
    const queue: number[] = [];
    const loop = catchUp({} as Env, {
      timers: { setTimeout: (_fn, ms) => queue.push(ms), clearTimeout: () => {} },
      sync: () => Promise.resolve({ push: { pushed: 10_000, backlog: true } }),
      probe: () => Promise.resolve(true),
    });
    await loop.run();
    expect(queue).toEqual([5_000]);
  });
});

describe("sync visibility", () => {
  it("the spoke shows its hub, the records waiting and since when it is offline", async () => {
    const t = await pair();
    t.setDown(true);
    await pushToHub(t.spoke, t.fetchFn);
    const res = await serve(t.spoke)(new Request("https://s.example/api/admin/federation/sync", { headers: OP }));
    const body = (await res.json()) as {
      hub: { url: string; offlineSince: number | null; waiting: Record<string, number> };
    };
    expect(body.hub.url).toBe(t.hubUrl);
    expect(body.hub.offlineSince).toBeTypeOf("number");
    expect(body.hub.waiting.cache).toBe(3);
  });

  it("the hub lists each spoke's last submission and marks a quiet one stale", async () => {
    const t = await pair();
    await pushToHub(t.spoke, t.fetchFn);
    const get = async () =>
      (await (
        await serve(t.hub)(new Request("https://hub.example/api/admin/federation/sync", { headers: OP }))
      ).json()) as {
        spokes: { instance: string; stale: boolean; lastSubmitAt: number }[];
      };
    expect((await get()).spokes).toMatchObject([{ instance: "s.example", stale: false }]);
    await t.hub.DB.prepare("UPDATE fed_submit_marks SET submitted_at = submitted_at - 25 * 3600").run();
    expect((await get()).spokes[0]?.stale).toBe(true);
  });

  it("Sync now needs the operator and starts a sync", async () => {
    const t = await pair();
    const anon = await serve(t.spoke)(new Request("https://s.example/api/admin/federation/sync", { method: "POST" }));
    expect([401, 403]).toContain(anon.status);
    const res = await serve(t.spoke)(
      new Request("https://s.example/api/admin/federation/sync", { method: "POST", headers: OP }),
    );
    expect(res.status).toBe(202);
  });
});
