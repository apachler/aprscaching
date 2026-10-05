// SPDX-License-Identifier: AGPL-3.0-or-later
// Against real SQLite: a BBS post is bounded and budgeted, the outbox ack refuses a body it cannot read, the
// White Pages learn a sender's home BBS from R: headers and keep the operator's entries, and a cache whose
// code is taken leaves no row behind.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import {
  handleBbsPost,
  BBS_BODY_MAX_BYTES,
  BBS_SUBJECT_MAX,
  BBS_LIFETIME_MAX_SEC,
  BBS_POSTS_PER_DAY,
} from "@aprscaching/gateway/bbs";
import { handleForwardInbound, handleWhitePages, originBbs } from "@aprscaching/gateway/forward";
import { outboxAck } from "@aprscaching/gateway/outbox";
import { handleCreateCache } from "@aprscaching/gateway/caches";
import { issueSessionCookie } from "@aprscaching/gateway/auth";
import type { Env } from "@aprscaching/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const SECRET = "a-strong-test-secret";

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  env = {
    DB: makeD1(sqlite),
    INGEST_SECRET: SECRET,
    OPERATOR_SECRET: "a-strong-operator-secret",
    SESSION_SECRET: "a-strong-session-secret",
    INSTANCE: "gw.test",
  } as unknown as Env;
});

const ingest = (url: string, body: unknown) =>
  new Request(`http://gw.test${url}`, {
    method: "POST",
    headers: { "x-ingest-secret": SECRET, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const post = (b: Record<string, unknown>) =>
  handleBbsPost(ingest("/api/bbs/messages", { fromCall: "OE8APR", toCall: "OE1TST", body: "hi", ...b }), env);

describe("BBS post bounds", () => {
  it("answers 400, not 500, when a call or the body is not text", async () => {
    for (const b of [{ fromCall: 7 }, { toCall: { x: 1 } }, { body: ["a"] }, { subject: 5 }])
      expect((await post(b)).status).toBe(400);
    const junk = await handleBbsPost(ingest("/api/bbs/messages", "[1,2]"), env);
    expect(junk.status).toBe(400);
  });

  it("caps the body in UTF-8 bytes and the subject in characters", async () => {
    expect((await post({ body: "x".repeat(BBS_BODY_MAX_BYTES) })).status).toBe(201);
    expect((await post({ body: "ä".repeat(BBS_BODY_MAX_BYTES / 2 + 1) })).status).toBe(413); // two bytes each
    expect((await post({ subject: "s".repeat(BBS_SUBJECT_MAX) })).status).toBe(201);
    expect((await post({ subject: "s".repeat(BBS_SUBJECT_MAX + 1) })).status).toBe(400);
  });

  it("takes a positive lifetime up to 30 days and keeps the bulletin default", async () => {
    for (const lifetimeSec of [0, -5, 1.5, "60", BBS_LIFETIME_MAX_SEC + 1])
      expect((await post({ lifetimeSec })).status).toBe(400);
    expect((await post({ lifetimeSec: 3600 })).status).toBe(201);
    const bln = (await (await post({ toCall: "ALL" })).json()) as { id: number };
    const row = sqlite.prepare("SELECT posted_at, expires_at FROM bbs_messages WHERE id=?").get(bln.id) as {
      posted_at: number;
      expires_at: number;
    };
    expect(row.expires_at - row.posted_at).toBe(BBS_LIFETIME_MAX_SEC);
  });

  it("holds a sender to a daily budget through the ingest box", async () => {
    for (let i = 0; i < BBS_POSTS_PER_DAY; i++) expect((await post({})).status).toBe(201);
    expect((await post({ fromCall: "OE8APR-7" })).status).toBe(429); // an SSID shares its base call's budget
    expect((await post({ fromCall: "OE5NEW" })).status).toBe(201);
  });

  it("holds a signed-in account to a daily budget", async () => {
    const t = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO accounts (account_id, callsign, created_at) VALUES ('acct-apr','OE8APR',?)").run(t);
    sqlite
      .prepare("INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-apr','OE8APR',?)")
      .run(t);
    const cookie = (await issueSessionCookie(new Request("http://gw.test/"), env, "acct-apr", "OE8APR")).split(";")[0]!;
    const send = () =>
      handleBbsPost(
        new Request("http://gw.test/api/bbs/messages", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ fromCall: "OE8APR", toCall: "OE1TST", body: "hi" }),
        }),
        env,
      );
    for (let i = 0; i < BBS_POSTS_PER_DAY; i++) expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
  });
});

describe("outbox ack", () => {
  it("answers 400 to a body that is not JSON or ids that are not ids", async () => {
    expect((await outboxAck(ingest("/outbox/ack", "{not json"), env)).status).toBe(400);
    expect((await outboxAck(ingest("/outbox/ack", { ids: "1,2" }), env)).status).toBe(400);
    expect((await outboxAck(ingest("/outbox/ack", { ids: [1, "x"] }), env)).status).toBe(400);
    expect((await outboxAck(ingest("/outbox/ack", { ids: [] }), env)).status).toBe(200);
  });
});

describe("White Pages learning", () => {
  const home = (call: string) =>
    sqlite.prepare("SELECT home_bbs, source FROM white_pages WHERE callsign=?").get(call) as
      { home_bbs: string; source: string } | undefined;
  const inbound = (bid: string, body: string) =>
    handleForwardInbound(
      ingest("/api/bbs/forward/inbound", {
        message: { type: "P", from: "OE5ABC", at: "OE8XBM", to: "OE8APR", bid, title: "t", body },
        origin: "rf-fbb:OE8XBM-1",
      }),
      env,
    );

  it("reads the sender's home BBS from the oldest R: line", () => {
    const body = [
      "R:261004/1200Z 4711@OE8XBM.#KAR.AUT.EU [Klagenfurt] FBB7.00",
      "R:261004/1150Z @:OE5XBL.#OOE.AUT.EU [Linz] FBB7.00",
      "",
      "Hello",
      "R:not a header",
    ].join("\r\n");
    expect(originBbs(body)).toBe("OE5XBL.#OOE.AUT.EU");
    expect(originBbs("no headers here")).toBeNull();
  });

  it("learns from R: headers and never from the partner that handed the mail over", async () => {
    await inbound("B1_OE5XBL", "no header");
    expect(home("OE5ABC")).toBeUndefined();
    await inbound("B2_OE5XBL", "R:261004/1150Z @:OE5XBL.#OOE.AUT.EU\r\n\r\nHello");
    expect(home("OE5ABC")).toEqual({ home_bbs: "OE5XBL.#OOE.AUT.EU", source: "learned" });
  });

  it("keeps the operator's entry over a learned one", async () => {
    const set = (headers: Record<string, string>, homeBbs: string) =>
      handleWhitePages(
        new Request("http://gw.test/api/bbs/wp", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ callsign: "OE5ABC", homeBbs }),
        }),
        env,
      );
    expect((await set({ "x-operator-secret": "a-strong-operator-secret" }, "OE5XYZ.#OOE.AUT.EU")).status).toBe(200);
    await inbound("B3_OE5XBL", "R:261004/1150Z @:OE5XBL.#OOE.AUT.EU\r\n\r\nHello");
    expect((await set({ "x-ingest-secret": SECRET }, "DB0ZZZ.#BAY.DEU.EU")).status).toBe(200);
    expect(home("OE5ABC")).toEqual({ home_bbs: "OE5XYZ.#OOE.AUT.EU", source: "manual" });
  });
});

describe("cache create", () => {
  const create = (code?: string) =>
    handleCreateCache(
      ingest("/api/caches", { title: "Hut", lat: 47, lon: 15, ownerCall: "OE8APR", ...(code && { code }) }),
      env,
    );
  const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM caches").get() as { n: number }).n;

  it("a taken code answers 409 and leaves no row behind", async () => {
    expect((await create("GC12345")).status).toBe(201);
    expect((await create("GC12345")).status).toBe(409);
    expect(count()).toBe(1);
    expect(sqlite.prepare("SELECT code FROM caches").all()).toEqual([{ code: "GC12345" }]);
  });

  it("mints an AC- code when none is given", async () => {
    const res = (await (await create()).json()) as { cache: { code: string } };
    expect(res.cache.code).toMatch(/^AC-\d{4}$/);
  });

  it("a hide badge that cannot be awarded does not fail the create", async () => {
    sqlite.exec("DROP TABLE achievements");
    expect((await create()).status).toBe(201);
    expect(count()).toBe(1);
  });
});
