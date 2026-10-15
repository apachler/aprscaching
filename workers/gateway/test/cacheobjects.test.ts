// SPDX-License-Identifier: AGPL-3.0-or-later
// Caches as APRS objects on air: off by default and the sysop's alone to turn on; a new or changed object is
// announced a few times, then backs off to the slow rate; a run sends a few objects at most, kills first; a cache
// that leaves the set is killed three times and then forgotten.
import { describe, it, expect } from "vitest";
import {
  cacheObjectsConfig,
  KILL_SENDS,
  planCacheObjects,
  runCacheObjects,
  type ObjectRow,
} from "../src/cacheobjects.js";
import { handleAdminSettings } from "../src/sitesettings.js";
import type { Env } from "../src/env.js";

const cfg = { intervalS: 30 * 60, perRun: 2 };
const mill = { name: "AC-1", lat: 46.6, lon: 14.3, comment: "Old mill" };
const row = (o: Partial<ObjectRow> = {}): ObjectRow => ({ ...mill, alive: 1, sends: 0, last_sent: null, ...o });

/** A database every use of which fails the test: nothing may be read or written. */
const untouchable = () =>
  ({
    prepare() {
      throw new Error("the database was used");
    },
  }) as unknown as Env["DB"];

/** Run the planner over `minutes` of five-minute runs, applying each plan; the minutes each object went out. */
function simulate(wanted: (typeof mill)[], minutes: number, start: ObjectRow[] = [], perRun = cfg.perRun) {
  let rows = start;
  const sent: { at: number; name: string; alive: boolean }[] = [];
  for (let m = 0; m <= minutes; m += 5) {
    const p = planCacheObjects(rows, wanted, m * 60, { ...cfg, perRun });
    for (const s of p.send) sent.push({ at: m, name: s.name, alive: s.alive });
    const up = new Map(p.upsert.map((r) => [r.name, r]));
    rows = [...rows.filter((r) => !p.remove.includes(r.name) && !up.has(r.name)), ...up.values()];
  }
  return { sent, rows };
}

describe("cache objects: off by default, the sysop's switch", () => {
  it("is off with no setting, and an off run touches neither the database nor a box", async () => {
    const env = { DB: untouchable() } as unknown as Env;
    expect(cacheObjectsConfig(env)).toMatchObject({ on: false, radiusKm: 20, intervalS: 1800, perRun: 2, path: [] });
    expect(await runCacheObjects(env)).toEqual({ skipped: "off" });
  });

  it("keeps the settings in their bounds and the path at one hop at most", () => {
    const env = {
      CACHE_OBJECTS: "1",
      CACHE_OBJECTS_RADIUS_KM: "500",
      CACHE_OBJECTS_INTERVAL_MIN: "5",
      CACHE_OBJECTS_PER_RUN: "50",
      CACHE_OBJECTS_PATH: "WIDE2-2",
    } as unknown as Env;
    expect(cacheObjectsConfig(env)).toMatchObject({ on: true, radiusKm: 20, intervalS: 1800, perRun: 2, path: [] });
    expect(cacheObjectsConfig({ CACHE_OBJECTS_PATH: "WIDE1-1" } as unknown as Env).path).toEqual(["WIDE1-1"]);
  });

  it("refuses the switch to anyone but the sysop", async () => {
    const env = { ADMIN_CALLSIGNS: "OE8APR", DB: untouchable() } as unknown as Env;
    const put = (headers: Record<string, string> = {}) =>
      handleAdminSettings(
        new Request("https://gw.example/api/admin/settings/CACHE_OBJECTS", {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ value: "1" }),
        }),
        env,
        "CACHE_OBJECTS",
      );
    expect((await put()).status).toBe(403);
    // the ingest secret never reaches operator configuration
    expect((await put({ "x-ingest-secret": "s3cret" })).status).toBe(403);
    expect((await put({ "x-operator-secret": "wrong" })).status).toBe(401);
  });
});

describe("cache objects: the decay and the rate", () => {
  it("announces a new object at once, 5, 10 and 20 minutes apart, then at the slow rate", () => {
    const { sent } = simulate([mill], 130);
    expect(sent.map((s) => s.at)).toEqual([0, 5, 15, 35, 65, 95, 125]);
  });

  it("starts the decay again when the cache changes", () => {
    const settled = row({ sends: 6, last_sent: 0 });
    const p = planCacheObjects([settled], [{ ...mill, lat: 46.61 }], 60, cfg);
    expect(p.send).toEqual([{ ...mill, lat: 46.61, alive: true }]);
    expect(p.upsert[0]).toMatchObject({ lat: 46.61, sends: 1, last_sent: 60 });
  });

  it("sends at most the run's share, the least announced first, and the rest later", () => {
    const wanted = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"].map((name) => ({ ...mill, name }));
    const first = planCacheObjects([], wanted, 0, cfg);
    expect(first.send.map((s) => s.name)).toEqual(["AC-1", "AC-2"]);
    // the others are kept unsent, so the next run takes them before any repeat
    expect(first.upsert.filter((r) => r.last_sent === null).map((r) => r.name)).toEqual(["AC-3", "AC-4", "AC-5"]);
    const { sent } = simulate(wanted, 120);
    const perRun = new Map<number, number>();
    for (const s of sent) perRun.set(s.at, (perRun.get(s.at) ?? 0) + 1);
    expect(Math.max(...perRun.values())).toBeLessThanOrEqual(cfg.perRun);
    // past the first announcements no object repeats sooner than the slow rate
    for (const name of wanted.map((w) => w.name)) {
      const at = sent.filter((s) => s.name === name).map((s) => s.at);
      const gaps = at.slice(1).map((t, i) => t - at[i]!);
      expect(gaps.slice(3).every((g) => g >= 30)).toBe(true);
      expect(gaps.every((g) => g >= 5)).toBe(true);
    }
  });
});

describe("cache objects: killed when a cache leaves", () => {
  it("kills an archived (no longer wanted) object three times, before anything else, then forgets it", () => {
    const onAir = [row({ sends: 6, last_sent: 0 })];
    const other = { ...mill, name: "AC-2" };
    const { sent, rows } = simulate([other], 60, onAir, 1);
    const kills = sent.filter((s) => s.name === "AC-1");
    expect(kills.map((s) => s.alive)).toEqual(Array(KILL_SENDS).fill(false));
    expect(kills.map((s) => s.at)).toEqual([0, 5, 15]);
    // the kill goes before the new object in the same run
    expect(sent[0]).toEqual({ at: 0, name: "AC-1", alive: false });
    expect(rows.map((r) => r.name)).toEqual(["AC-2"]);
  });

  it("forgets an object that never went on air instead of killing it", () => {
    const p = planCacheObjects([row()], [], 0, cfg);
    expect(p).toEqual({ send: [], upsert: [], remove: ["AC-1"] });
  });

  it("brings a killed object back to life when its cache returns", () => {
    const p = planCacheObjects([row({ alive: 0, sends: 1, last_sent: 0 })], [mill], 60, cfg);
    expect(p.send).toEqual([{ ...mill, alive: true }]);
  });
});
