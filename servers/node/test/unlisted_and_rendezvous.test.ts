// SPDX-License-Identifier: AGPL-3.0-or-later
// An unlisted cache stays off the map and out of search for everyone but its owner, and opens by its link.
// A living cache's rendezvous show their time and place to the cache's owner only.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const BBOX = "/api/caches?bbox=14,46,16,48";
const codes = (r: { data: { caches: { code: string }[] } }) => r.data.caches.map((c) => c.code);

describe("an unlisted cache", () => {
  it("is off the map and out of search, except for its owner, and opens by its link", async () => {
    const env = authEnv();
    const owner = await emailSignup(env, "owner@example.test", "OE8UNL");
    const other = await emailSignup(env, "other@example.test", "OE8OTH");
    const hidden = await call(
      env,
      "POST",
      "/api/caches",
      { title: "quiet oak", type: "traditional", lat: 47, lon: 15, fedScope: "unlisted" },
      { cookie: owner.cookie },
    );
    expect(hidden.status, JSON.stringify(hidden.data)).toBe(201);
    const { id, code } = hidden.data.cache;

    expect(codes(await call(env, "GET", BBOX))).not.toContain(code);
    expect(codes(await call(env, "GET", BBOX, undefined, { cookie: other.cookie }))).not.toContain(code);
    expect(codes(await call(env, "GET", BBOX, undefined, { cookie: owner.cookie }))).toContain(code);

    const search = (cookie?: string) =>
      call(env, "GET", "/api/search?q=quiet", undefined, cookie ? { cookie } : {}).then((r) =>
        r.data.caches.map((c: { code: string }) => c.code),
      );
    expect(await search()).not.toContain(code);
    expect(await search(owner.cookie)).toContain(code);

    const detail = await call(env, "GET", `/api/caches/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.data.cache.code).toBe(code);
  });
});

describe("a living cache's rendezvous", () => {
  it("give the time and place to the owner, and the day alone to anyone else", async () => {
    const env = authEnv();
    const owner = await emailSignup(env, "rover@example.test", "OE8RDV");
    // the station rule is covered in living_cache_station.test.ts; the ingest secret path skips it here
    const made = await call(
      env,
      "POST",
      "/api/caches",
      {
        title: "rover",
        type: "aprs_living",
        stationCall: "OE8RDV-9",
        lat: 47,
        lon: 15,
        rendezvous: true,
        ownerCall: "OE8RDV",
      },
      { "x-ingest-secret": String(env.INGEST_SECRET) },
    );
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const id = made.data.cache.id;
    const ts = 1_790_000_000;
    await env.DB.prepare(
      "INSERT INTO rendezvous_log (cache_a, cache_b, call_a, call_b, ts, lat, lon) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, id + 1000, "OE8RDV-9", "DL1ABC-9", ts, 47.1, 15.2)
      .run();

    const mine = (await call(env, "GET", `/api/caches/${id}`, undefined, { cookie: owner.cookie })).data.cache
      .rendezvous[0];
    expect(mine).toMatchObject({ withCall: "DL1ABC-9", ts, lat: 47.1, lon: 15.2 });
    expect(mine.day).toBeUndefined();

    const theirs = (await call(env, "GET", `/api/caches/${id}`)).data.cache.rendezvous[0];
    expect(theirs).toMatchObject({ withCall: "DL1ABC-9", lat: null, lon: null, day: true });
    expect(theirs.ts % 86_400).toBe(43_200);
    expect(Math.abs(theirs.ts - ts)).toBeLessThan(86_400);
  });
});
