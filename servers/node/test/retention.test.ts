// SPDX-License-Identifier: AGPL-3.0-or-later
// The nightly prune of the operational queues and logs: the APRS-IS outbox, box commands, bulletins and the
// FBB forward log, unseen watch alerts, and long-silent stations — each kept only as long as it is of use.
import { describe, it, expect } from "vitest";
import { authEnv, call, markCallVerified } from "./helpers/authflow.js";
import { runScheduled } from "@aprscaching/gateway/app";
import type { Env } from "@aprscaching/gateway/env";

const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const DAY = 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

const col = async (env: Env, sql: string) =>
  (await env.DB.prepare(sql).all<Record<string, unknown>>()).results.map((r) => Object.values(r)[0]);

async function outboxItem(env: Env, payload: string, age: number, status = "queued") {
  await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, kind, payload, status, sent_at) VALUES (?, 'OE8APR-15', 'wx', ?, ?, ?)",
  )
    .bind(now() - age, payload, status, status === "sent" ? now() - age : null)
    .run();
}

describe("the APRS-IS outbox", () => {
  it("never hands the box an item queued more than an hour ago, and prunes queued and sent items", async () => {
    const env = authEnv({ ROOMS });
    await markCallVerified(env, "OE8APR"); // the drain serves only a call still control-verified
    await outboxItem(env, "fresh", 60);
    await outboxItem(env, "stale", 2 * 3600);
    await outboxItem(env, "sent-recent", 2 * DAY, "sent");
    await outboxItem(env, "sent-old", 8 * DAY, "sent");
    const pending = await call(env, "GET", "/outbox", undefined, SECRET);
    expect(pending.data.items.map((i: { payload: string }) => i.payload)).toEqual(["fresh"]);
    await runScheduled(env);
    expect(await col(env, "SELECT payload FROM aprs_outbox ORDER BY id")).toEqual(["fresh", "sent-recent"]);
  });
});

describe("the nightly prune", () => {
  it("drops box commands after a week, whatever their state", async () => {
    const env = authEnv({ ROOMS });
    const add = (kind: string, status: string, age: number) =>
      env.DB.prepare("INSERT INTO box_commands (box_id, kind, status, created_at) VALUES ('box1', ?, ?, ?)")
        .bind(kind, status, now() - age)
        .run();
    await add("old-done", "done", 8 * DAY);
    await add("old-queued", "queued", 8 * DAY);
    await add("recent", "done", DAY);
    await runScheduled(env);
    expect(await col(env, "SELECT kind FROM box_commands")).toEqual(["recent"]);
  });

  it("gives an inbound bulletin the default lifetime, and deletes bulletins past theirs but never personal mail", async () => {
    const env = authEnv({ ROOMS });
    const inbound = (bid: string, type: string) =>
      call(
        env,
        "POST",
        "/api/bbs/forward/inbound",
        { message: { bid, type, from: "DL1ABC", to: type === "B" ? "ALL" : "OE1AAA", title: "t", body: "x" } },
        SECRET,
      );
    expect((await inbound("7_DB0ABC", "B")).data).toMatchObject({ stored: 1 });
    expect((await inbound("8_DB0ABC", "P")).data).toMatchObject({ stored: 1 });
    const stored = await env.DB.prepare("SELECT type, posted_at, expires_at FROM bbs_messages ORDER BY id").all<{
      type: string;
      posted_at: number;
      expires_at: number | null;
    }>();
    expect(stored.results[0]!.expires_at).toBe(stored.results[0]!.posted_at + 30 * DAY);
    expect(stored.results[1]!.expires_at).toBeNull();

    const add = (bid: string, type: string, postedAge: number, expiresIn: number | null) =>
      env.DB.prepare(
        "INSERT INTO bbs_messages (bid, type, from_call, to_call, body, posted_at, expires_at, origin) VALUES (?,?, 'DL1ABC', 'ALL', 'x', ?, ?, 'rf-fbb')",
      )
        .bind(bid, type, now() - postedAge, expiresIn == null ? null : now() + expiresIn)
        .run();
    await add("EXPIRED", "B", 2 * DAY, -60);
    await add("NULL-OLD", "B", 31 * DAY, null); // stored without an expiry: lives the default from its posting
    await add("NULL-NEW", "B", 2 * DAY, null);
    await add("P-OLD", "P", 400 * DAY, null);
    await runScheduled(env);
    expect(await col(env, "SELECT bid FROM bbs_messages ORDER BY bid")).toEqual([
      "7_DB0ABC",
      "8_DB0ABC",
      "NULL-NEW",
      "P-OLD",
    ]);
  });

  it("keeps a forward-log entry past 30 days only while its message is still offered for forwarding", async () => {
    const env = authEnv({ ROOMS });
    await env.DB.prepare(
      "INSERT INTO bbs_messages (bid, type, from_call, to_call, body, posted_at, origin) VALUES ('LIVE_OE8APR', 'P', 'OE8APR', 'DL1ABC', 'x', ?, 'local')",
    )
      .bind(now() - 60 * DAY)
      .run();
    const log = (bid: string, age: number) =>
      env.DB.prepare("INSERT INTO bbs_forward_log (partner, bid, forwarded_at) VALUES ('DB0ABC', ?, ?)")
        .bind(bid, now() - age)
        .run();
    await log("LIVE_OE8APR", 40 * DAY);
    await log("GONE_OE8APR", 40 * DAY);
    await log("RECENT_OE8APR", DAY);
    await runScheduled(env);
    expect(await col(env, "SELECT bid FROM bbs_forward_log ORDER BY bid")).toEqual(["LIVE_OE8APR", "RECENT_OE8APR"]);
  });

  it("drops watch alerts nobody saw within 30 days", async () => {
    const env = authEnv({ ROOMS });
    const alert = (detail: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO watch_alerts (account_id, callsign, kind, detail, ts, seen) VALUES ('a1', 'OE8APR', 'heard', ?, ?, 0)",
      )
        .bind(detail, now() - age)
        .run();
    await alert("old", 31 * DAY);
    await alert("recent", DAY);
    await runScheduled(env);
    expect(await col(env, "SELECT detail FROM watch_alerts")).toEqual(["recent"]);
  });

  it("drops stations silent for a year, except those a living cache, a registered station or a node names", async () => {
    const env = authEnv({ ROOMS });
    const station = (call: string, age: number) =>
      env.DB.prepare("INSERT INTO stations (callsign, lat, lon, last_seen) VALUES (?, 47, 15, ?)")
        .bind(call, now() - age)
        .run();
    await station("OE1OLD", 400 * DAY);
    await station("OE1NEW", 30 * DAY);
    await station("OE1LIV-9", 400 * DAY);
    await station("OE1REG-1", 400 * DAY);
    await station("OE1MSH-12", 400 * DAY);
    await env.DB.prepare(
      "INSERT INTO caches (code, owner_call, title, type, station_call, lat, lon, created_at, updated_at) VALUES ('AC-LIV', 'OE1LIV', 'living', 'aprs_living', 'oe1liv-9', 47, 15, 1, 1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO account_stations (account_id, callsign, created_at, updated_at) VALUES ('a1', 'OE1REG-1', 1, 1)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO meshcom_nodes (callsign, last_heard, last_via, updated_at) VALUES ('OE1MSH-12', ?, 'direct', ?)",
    )
      .bind(now(), now())
      .run();
    await runScheduled(env);
    expect(await col(env, "SELECT callsign FROM stations ORDER BY callsign")).toEqual([
      "OE1LIV-9",
      "OE1MSH-12",
      "OE1NEW",
      "OE1REG-1",
    ]);
  });
});
