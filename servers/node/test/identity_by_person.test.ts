// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage unlocks, ratings, favourites and the RSS feeds follow the person — the base call, every SSID of it and
// every call on the account — never the exact call string a request carries. Runs against real SQLite.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { issueSessionCookie } from "@aprscaching/gateway/auth";
import { handleGetStages, handleUnlockStage } from "@aprscaching/gateway/stages";
import { handleRate, handleFavorite, ratingInfo, favoritesInfo } from "@aprscaching/gateway/community";
import { handleLeaderboardFeed, handleUserFeed } from "@aprscaching/gateway/feeds";
import type { Env } from "@aprscaching/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const INGEST_SECRET = "a-strong-test-secret";

let sqlite: Database.Database;
let env: Env;
let t: number;

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  env = {
    DB: makeD1(sqlite),
    INGEST_SECRET,
    SESSION_SECRET: "a-strong-session-secret",
    INSTANCE: "gw.test",
  } as unknown as Env;
  t = Math.floor(Date.now() / 1000);
  // one account holding two base calls, OE8XYZ active
  sqlite.prepare("INSERT INTO accounts (account_id, callsign, created_at) VALUES ('acct-apr','OE8XYZ',?)").run(t);
  sqlite
    .prepare(
      "INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-apr','OE8APR',?), ('acct-apr','OE8XYZ',?)",
    )
    .run(t, t);
  sqlite
    .prepare(
      "INSERT INTO caches (id, code, owner_call, title, type, lat, lon, created_at, updated_at, rating_policy) VALUES (1,'AC-0001','OE3OWN','Multi','multi',47.07,15.42,?,?,'finders')",
    )
    .run(t, t);
  sqlite
    .prepare(
      "INSERT INTO cache_stages (cache_id, stage_no, lat, lon, unlock) VALUES (1,0,47.07,15.42,NULL), (1,1,47.08,15.43,'open'), (1,2,47.09,15.44,'open')",
    )
    .run();
});

async function as(call: string, url: string, init: RequestInit = {}): Promise<Request> {
  const cookie = (await issueSessionCookie(new Request("http://gw.test/"), env, "acct-apr", call)).split(";")[0]!;
  return new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const unlock = (call: string, cacheId: number, stageNo: number) =>
  sqlite
    .prepare("INSERT INTO stage_unlocks (callsign, cache_id, stage_no, unlocked_at) VALUES (?,?,?,?)")
    .run(call, cacheId, stageNo, t);

describe("stage unlocks follow the person", () => {
  for (const [label, stored] of [
    ["another base call on the account", "OE8APR"],
    ["an SSID of the session's call", "OE8XYZ-7"],
  ] as const) {
    it(`an unlock under ${label} opens the stage and its successor`, async () => {
      unlock(stored, 1, 1);
      const list = (await (
        await handleGetStages(await as("OE8XYZ", "http://gw.test/api/caches/1/stages"), env, 1)
      ).json()) as {
        stages: { stageNo: number; unlocked: boolean; lat: number | null }[];
      };
      expect(list.stages.find((s) => s.stageNo === 1)).toMatchObject({ unlocked: true, lat: 47.08 });
      const res = await handleUnlockStage(await as("OE8XYZ", "http://gw.test/x", post({})), env, 1, 2);
      expect(res.status).toBe(200);
    });
  }

  it("an unlock by someone else stays theirs", async () => {
    unlock("DL1ABC", 1, 1);
    const res = await handleUnlockStage(await as("OE8XYZ", "http://gw.test/x", post({})), env, 1, 2);
    expect(res.status).toBe(403);
  });
});

describe("ratings and favourites count one person once", () => {
  beforeEach(() => {
    sqlite
      .prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (1,'OE8XYZ',?,'found',1,'B')",
      )
      .run(t);
  });

  it("a rating from each SSID and each held call is the person's one rating", async () => {
    for (const [call, stars] of [
      ["OE8XYZ", 1],
      ["OE8XYZ-1", 2],
      ["OE8XYZ-15", 3],
    ] as const)
      expect((await handleRate(await as(call, "http://gw.test/x", post({ stars })), env, 1)).status).toBe(200);
    // the ingest path naming the other base call of the same account
    const viaIngest = new Request("http://gw.test/x", {
      ...post({ stars: 5, callsign: "OE8APR-9" }),
      headers: { "content-type": "application/json", "x-ingest-secret": INGEST_SECRET },
    });
    expect((await handleRate(viaIngest, env, 1)).status).toBe(200);
    const info = await ratingInfo(env, 1, "finders", "OE8XYZ-3");
    expect(info).toMatchObject({ count: 1, avg: 5, mine: 5 });
  });

  it("a favourite from several SSIDs counts once, and either clears it", async () => {
    for (const call of ["OE8XYZ", "OE8XYZ-7"])
      expect(
        (await (
          await handleFavorite(await as(call, "http://gw.test/x", post({ on: true })), env, 1)
        ).json()) as unknown,
      ).toMatchObject({ on: true, count: 1 });
    expect(await favoritesInfo(env, 1, "OE8APR-2")).toEqual({ favorites: 1, favorited: true });
    const off = (await (
      await handleFavorite(await as("OE8XYZ-9", "http://gw.test/x", post({ on: false })), env, 1)
    ).json()) as {
      count: number;
    };
    expect(off.count).toBe(0);
  });

  it("another account's rating and favourite stay theirs", async () => {
    sqlite
      .prepare("INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-dl','DL1ABC',?)")
      .run(t);
    sqlite.prepare("INSERT INTO cache_ratings (cache_id, callsign, stars, ts) VALUES (1,'DL1ABC',2,?)").run(t);
    sqlite.prepare("INSERT INTO favorites (callsign, cache_id) VALUES ('DL1ABC',1)").run();
    expect(await favoritesInfo(env, 1, "OE8XYZ")).toEqual({ favorites: 1, favorited: false });
    expect(await ratingInfo(env, 1, "finders", "OE8XYZ")).toMatchObject({ count: 1, mine: null });
    expect((await handleRate(await as("OE8XYZ", "http://gw.test/x", post({ stars: 4 })), env, 1)).status).toBe(200);
    expect(await handleFavorite(await as("OE8XYZ", "http://gw.test/x", post({ on: true })), env, 1)).toBeTruthy();
    expect(await ratingInfo(env, 1, "finders", "DL1ABC")).toMatchObject({ count: 2, avg: 3, mine: 2 });
    expect(await favoritesInfo(env, 1, "DL1ABC")).toEqual({ favorites: 2, favorited: true });
  });
});

describe("RSS feeds rank and list the person", () => {
  beforeEach(() => {
    for (let id = 2; id <= 4; id++)
      sqlite
        .prepare(
          "INSERT INTO caches (id, code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES (?,?,'OE3OWN','C','traditional',47,15,?,?)",
        )
        .run(id, `AC-000${id}`, t, t);
    const log = sqlite.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (?,?,?,'found',1,'B')",
    );
    log.run(2, "OE8APR-7", t);
    log.run(3, "OE8APR-9", t + 1);
    log.run(4, "XX1XX", t + 2); // a call nobody control-verified
    sqlite
      .prepare(
        "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8APR','operator','verified',?)",
      )
      .run(t);
  });

  it("the leaderboard feed ranks verified people, their SSIDs together", async () => {
    const body = await (await handleLeaderboardFeed(new Request("http://gw.test/feeds/leaderboard.xml"), env)).text();
    const titles = [...body.matchAll(/<item>\s*<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    expect(titles).toEqual(["#1 OE8APR — 2 verified finds"]);
  });

  it("a person's feed lists the finds of every SSID", async () => {
    const body = await (await handleUserFeed(new Request("http://gw.test/feeds/u/OE8APR.xml"), env, "OE8APR")).text();
    expect(body).toContain("AC-0002");
    expect(body).toContain("AC-0003");
    expect(body).toContain("2 verified finds");
  });
});
