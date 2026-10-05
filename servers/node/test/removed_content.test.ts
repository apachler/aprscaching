// SPDX-License-Identifier: AGPL-3.0-or-later
// A cache the sysop removed leaves every public surface and every write path: the adoption flow, the map and
// search, its owner's stages and media, logs and stage unlocks, the leaderboards and the feeds. The feeds never
// show a person marker, and a removal that answers a report acts only on the person the report named.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";
import { cachesNear } from "@aprscaching/gateway/live";
import { recordRendezvous } from "@aprscaching/gateway/rendezvous";

interface World {
  env: Env;
  sysop: Res;
}

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

const stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
const media = () => ({
  put: async (k: string, bytes: Uint8Array, o?: { contentType?: string }) =>
    void stored.set(k, { bytes, contentType: o?.contentType ?? "image/jpeg" }),
  get: async (k: string) => stored.get(k) ?? null,
  delete: async (k: string) => void stored.delete(k),
});

async function world(): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", HIDE_DAILY_LIMIT: "50", MEDIA: media() });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

const accountOf = async (env: Env, cs: string) =>
  (await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string }>())!.account_id;

async function user(w: World, cs: string): Promise<Res> {
  const s = await emailSignup(w.env, `${cs.toLowerCase()}@example.test`, cs, nextIp());
  expect(s.status).toBe(200);
  const v = await call(
    w.env,
    "POST",
    "/api/admin/verifications",
    { callsign: cs, note: "licence checked", holder: await accountOf(w.env, cs) },
    { cookie: w.sysop.cookie },
  );
  expect(v.status).toBe(201);
  return s;
}

const as = (r: Res) => ({ cookie: r.cookie });

async function hide(w: World, owner: Res): Promise<{ id: number; code: string }> {
  const r = await call(
    w.env,
    "POST",
    "/api/caches",
    { title: "under the oak", type: "traditional", lat: 47.1, lon: 15.4, description: "a box" },
    as(owner),
  );
  expect(r.status).toBe(201);
  return { id: r.data.cache.id as number, code: r.data.cache.code as string };
}

const remove = (w: World, id: number) =>
  call(
    w.env,
    "POST",
    "/api/admin/moderation/remove",
    { kind: "cache", id, reason: "advertising listing" },
    as(w.sysop),
  );

const raw = (env: Env, path: string, headers: Record<string, string> = {}) =>
  serve(env)(new Request(`https://gw.test${path}`, { headers: { "x-real-ip": nextIp(), ...headers } }));

describe("a removed cache leaves the adoption flow", () => {
  it("drops its offer, lapses open requests, and refuses a new offer, a request and a hand-over", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const adopter = await user(w, "DL1ADO");
    const { id } = await hide(w, owner);
    const offered = await call(
      w.env,
      "POST",
      "/api/admin/adoptions",
      { cacheId: id, note: "owner moved away" },
      as(w.sysop),
    );
    expect(offered.status).toBe(201);
    expect((await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, as(adopter))).status).toBe(201);

    expect((await remove(w, id)).status).toBe(200);

    const offers = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM cache_adoption_offers").first<{ n: number }>();
    expect(offers!.n).toBe(0);
    const req = await w.env.DB.prepare("SELECT status FROM cache_adoption_requests WHERE cache_id=?")
      .bind(id)
      .first<{ status: string }>();
    expect(req!.status).toBe("cancelled");
    expect((await call(w.env, "GET", "/api/adoptions")).data.adoptions).toEqual([]);
    const admin = await call(w.env, "GET", "/api/admin/adoptions", undefined, as(w.sysop));
    expect(admin.data.offered).toEqual([]);
    expect(admin.data.withdrawn).toEqual([]);

    const again = await call(w.env, "POST", "/api/admin/adoptions", { cacheId: id, note: "try again" }, as(w.sysop));
    expect(again.status).toBe(404);
    expect((await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, as(adopter))).status).toBe(404);
    const assign = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/${id}/assign`,
      { callsign: "DL1ADO", note: "hand it over" },
      as(w.sysop),
    );
    expect(assign.status).toBe(404);
    const row = await w.env.DB.prepare("SELECT owner_call, status FROM caches WHERE id=?")
      .bind(id)
      .first<{ owner_call: string; status: string }>();
    expect(row).toEqual({ owner_call: "DL1OWN", status: "archived" });
  });
});

describe("the public lists never show a removed cache", () => {
  it("leaves it off the map, search and an offline pack even while its status reads active", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const { id, code } = await hide(w, owner);
    const listed = async () => ({
      map: (await call(w.env, "GET", "/api/caches?bbox=15,47,16,48")).data.caches.map((c: { code: string }) => c.code),
      search: (await call(w.env, "GET", `/api/search?q=${code}`)).data.caches.map((c: { code: string }) => c.code),
      pack: (
        (await (await raw(w.env, "/api/offline/pack?grid=JN77")).json()) as { caches: { code: string }[] }
      ).caches.map((c) => c.code),
    });
    expect(await listed()).toEqual({ map: [code], search: [code], pack: [code] });
    // the removal marker alone hides it, whatever the status column says
    await w.env.DB.prepare("UPDATE caches SET removed_at=1 WHERE id=?").bind(id).run();
    expect(await listed()).toEqual({ map: [], search: [], pack: [] });
  });
});

describe("the owner of a removed cache", () => {
  it("can no longer change its stages or media, and its media answers only the owner and the sysop", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const other = await user(w, "DL1OTH");
    const { id } = await hide(w, owner);
    const key = `cache/${id}/media/0b8f3a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jpg`;
    stored.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
    await w.env.DB.prepare(
      "INSERT INTO cache_media (cache_id, media_key, kind, content_type, bytes, created_at) VALUES (?, ?, 'image', 'image/jpeg', 3, 1)",
    )
      .bind(id, key)
      .run();
    const before = await raw(w.env, `/api/media/${key}`);
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("public, max-age=86400");

    expect((await remove(w, id)).status).toBe(200);

    const stages = await call(
      w.env,
      "POST",
      `/api/caches/${id}/stages`,
      { stages: [{ stageNo: 0, unlock: "open", lat: 47.1, lon: 15.4 }] },
      as(owner),
    );
    expect(stages.status).toBe(403);
    expect(stages.data.error).toMatch(/removed/);
    const upload = await serve(w.env)(
      new Request(`https://gw.test/api/caches/${id}/media`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", cookie: owner.cookie, "x-real-ip": nextIp() },
        body: new Uint8Array(16),
      }),
    );
    expect(upload.status).toBe(403);

    expect((await raw(w.env, `/api/media/${key}`)).status).toBe(404);
    expect((await raw(w.env, `/api/media/${key}`, { cookie: other.cookie })).status).toBe(404);
    for (const who of [owner, w.sysop]) {
      const r = await raw(w.env, `/api/media/${key}`, { cookie: who.cookie });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

describe("a removed cache takes no log and no stage unlock", () => {
  it("answers a player as for a cache that does not exist, and tells its owner why", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const player = await user(w, "DL1PLY");
    const { id } = await hide(w, owner);
    expect((await remove(w, id)).status).toBe(200);

    const note = await call(w.env, "POST", `/api/caches/${id}/logs`, { logType: "note", comment: "hi" }, as(player));
    expect(note.status).toBe(404);
    expect(note.data.error).toBe("no such cache");
    const own = await call(w.env, "POST", `/api/caches/${id}/logs`, { logType: "note", comment: "fixed" }, as(owner));
    expect(own.status).toBe(409);
    expect(own.data.error).toMatch(/removed/);
    const unlock = await call(w.env, "POST", `/api/caches/${id}/stages/1/unlock`, {}, as(player));
    expect(unlock.status).toBe(404);
    const n = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id=?")
      .bind(id)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("the leaderboards and feeds", () => {
  it("drop finds on a removed cache", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    await user(w, "DL1FND");
    const { id } = await hide(w, owner);
    await w.env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (?, 'DL1FND', 1000, 'found', 1, 'B')",
    )
      .bind(id)
      .run();
    const board = async () =>
      (await call(w.env, "GET", "/api/leaderboard")).data.leaderboard.map((r: { loggerCall: string }) => r.loggerCall);
    const feed = async () => (await raw(w.env, "/feeds/leaderboard.xml")).text();
    expect(await board()).toContain("DL1FND");
    expect(await feed()).toContain("DL1FND");
    expect((await call(w.env, "GET", "/api/profile/DL1FND")).data.finds).toBe(1);

    expect((await remove(w, id)).status).toBe(200);
    expect(await board()).not.toContain("DL1FND");
    expect(await feed()).not.toContain("DL1FND");
    expect((await call(w.env, "GET", "/api/profile/DL1FND")).data.finds).toBe(0);
  });

  it("never show a person marker's suffix, and never rank a marker", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const { id } = await hide(w, owner);
    for (const who of ["WITHDRAWN#A1B2C3", "FORMER#D4E5F6"])
      await w.env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (?, ?, 1000, 'found', 1, 'B')",
      )
        .bind(id, who)
        .run();
    await w.env.DB.prepare("UPDATE caches SET owner_call='WITHDRAWN#A1B2C3' WHERE id=?").bind(id).run();

    const activity = await (await raw(w.env, "/feeds/activity.xml")).text();
    expect(activity).toContain("WITHDRAWN found");
    expect(activity).toContain("FORMER found");
    expect(activity).not.toMatch(/#A1B2C3|#D4E5F6/);
    expect(activity).not.toContain("<dc:creator>");
    const caches = await (await raw(w.env, "/feeds/caches.xml")).text();
    expect(caches).toContain("cache by WITHDRAWN");
    expect(caches).not.toContain("#A1B2C3");
    const board = await (await raw(w.env, "/feeds/leaderboard.xml")).text();
    expect(board).not.toMatch(/WITHDRAWN|FORMER/);
  });
});

describe("a removal that answers a report", () => {
  it("is refused once the reported call belongs to another account", async () => {
    const w = await world();
    const reported = await user(w, "DL1USR");
    const reporter = await user(w, "DL1REP");
    await call(w.env, "POST", "/auth/profile", { displayName: "Rude Name" }, as(reported));
    const rep = await call(
      w.env,
      "POST",
      "/api/reports",
      { kind: "profile", id: "DL1USR", category: "spam" },
      as(reporter),
    );
    expect(rep.status).toBe(201);
    // the call moves to its licensee's new account
    await user(w, "DL2NEW");
    const newHolder = await accountOf(w.env, "DL2NEW");
    await w.env.DB.prepare("UPDATE account_callsigns SET account_id=? WHERE callsign='DL1USR'").bind(newHolder).run();
    await w.env.DB.prepare("UPDATE accounts SET display_name='Kind Name' WHERE account_id=?").bind(newHolder).run();

    const refused = await call(
      w.env,
      "POST",
      "/api/admin/moderation/remove",
      { kind: "profile", id: "DL1USR", reason: "offensive name", reportId: rep.data.id },
      as(w.sysop),
    );
    expect(refused.status).toBe(409);
    const row = await w.env.DB.prepare("SELECT display_name FROM accounts WHERE account_id=?")
      .bind(newHolder)
      .first<{ display_name: string | null }>();
    expect(row!.display_name).toBe("Kind Name");
  });

  it("goes ahead while the reported account still holds the call", async () => {
    const w = await world();
    const reported = await user(w, "DL1USR");
    const reporter = await user(w, "DL1REP");
    await call(w.env, "POST", "/auth/profile", { displayName: "Rude Name" }, as(reported));
    const rep = await call(
      w.env,
      "POST",
      "/api/reports",
      { kind: "profile", id: "DL1USR", category: "spam" },
      as(reporter),
    );
    const r = await call(
      w.env,
      "POST",
      "/api/admin/moderation/remove",
      { kind: "profile", id: "DL1USR", reason: "offensive name", reportId: rep.data.id },
      as(w.sysop),
    );
    expect(r.status).toBe(200);
  });
});

describe("the live surfaces never offer a removed cache", () => {
  it("leaves it out of the nearby prompt and out of a living cache's rendezvous", async () => {
    const w = await world();
    const now = Math.floor(Date.now() / 1000);
    const add = async (code: string, station: string) =>
      Number(
        (
          await w.env.DB.prepare(
            `INSERT INTO caches (code, owner_call, title, type, lat, lon, station_call, rendezvous, created_at, updated_at)
             VALUES (?, 'DL1OWN', ?, 'aprs_living', 47.1, 15.4, ?, 1, 1, 1)`,
          )
            .bind(code, code, station)
            .run()
        ).meta.last_row_id,
      );
    const a = await add("AC-LIVA", "DL1AAA-9");
    const b = await add("AC-LIVB", "DL1BBB-9");
    for (const s of ["DL1AAA-9", "DL1BBB-9"])
      await w.env.DB.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES (?, 47.1, 15.4, ?)")
        .bind(s, now)
        .run();
    await w.env.DB.prepare("UPDATE caches SET removed_at=? WHERE id=?").bind(now, b).run();

    expect((await cachesNear(w.env, 47.1, 15.4)).map((c) => c.id)).toEqual([a]);
    const met = async () =>
      (await w.env.DB.prepare("SELECT COUNT(*) AS n FROM rendezvous_log").first<{ n: number }>())!.n;
    await recordRendezvous(w.env, [{ src: "DL1AAA-9", lat: 47.1, lon: 15.4 }]);
    expect(await met()).toBe(0);
    await w.env.DB.prepare("UPDATE caches SET removed_at=NULL WHERE id=?").bind(b).run();
    await recordRendezvous(w.env, [{ src: "DL1AAA-9", lat: 47.1, lon: 15.4 }]);
    expect(await met()).toBe(1);
  });
});
