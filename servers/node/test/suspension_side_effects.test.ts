// SPDX-License-Identifier: AGPL-3.0-or-later
// What a suspension, a removal and an erasure stop beyond the account's own writes: a weather station's pushes
// and beacons, queued APRS-IS traffic, held Mailbox mail, and the service call's copies of the person's Mailbox
// messages. Also the nightly retention of moderation records, claims and email links, the account export's
// delivery and suspension fields, and the rounding of a home-locator position.
import { describe, it, expect } from "vitest";
import { runScheduled } from "@aprscaching/gateway/app";
import { authEnv, call, emailSignup, markCallVerified, operatorVerify, type Res } from "./helpers/authflow.js";
import { newFedKey } from "./helpers/fedpeer.js";
import { accountActionMessage } from "@aprscaching/shared";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "test-ingest-secret";
const SERVICE = "OE8APR-15";
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;
const nowS = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

async function world(): Promise<{ env: Env; sysop: Res }> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}
const user = (env: Env, cs: string) => emailSignup(env, `${cs.toLowerCase()}@example.test`, cs, nextIp());
const sysopCall = (w: { env: Env; sysop: Res }, method: string, path: string, body?: unknown) =>
  call(w.env, method, `/api/admin/moderation${path}`, body, { cookie: w.sysop.cookie });
const suspend = (w: { env: Env; sysop: Res }, cs: string) =>
  sysopCall(w, "POST", `/accounts/${cs}/suspend`, { reason: "sent spam", category: "spam" });

const all = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;

async function queue(env: Env, src: string, payload: string, kind = "message"): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?, ?, 'APZACG', ?, ?)",
  )
    .bind(nowS(), src, kind, payload)
    .run();
  return Number(r.meta.last_row_id);
}

const pending = async (env: Env) =>
  (await call(env, "GET", "/outbox", undefined, { "x-ingest-secret": SECRET })).data as {
    items: { id: number; src_call: string; payload: string }[];
  };

/** A weather station of `cs` with a push key and no coordinates; returns the key. */
async function weatherStation(env: Env, cookie: string, cs: string, grid: string): Promise<string> {
  await env.DB.prepare("UPDATE accounts SET home_grid=? WHERE callsign=?").bind(grid, cs).run();
  const r = await call(env, "POST", "/api/my/stations", { callsign: `${cs}-13`, roles: ["weather"] }, { cookie });
  expect(r.status).toBe(201);
  return (await env.DB.prepare("SELECT key FROM wx_keys WHERE callsign=?").bind(cs).first<{ key: string }>())!.key;
}
const push = (env: Env, key: string) => call(env, "POST", `/api/wx/submit?key=${key}`, { tempf: "68", humidity: "50" });

/** Erase an account by a request signed with a device key registered to its call, as a suspended person can. */
async function signedErase(env: Env, cs: string) {
  const dev = await newFedKey();
  await env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,1)")
    .bind(cs, dev.pub, "phone")
    .run();
  const at = nowS();
  const msg = new TextEncoder().encode(
    accountActionMessage({ action: "delete", callsign: cs, instance: "gw.test", at }),
  );
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", dev.priv, msg)).toString("base64url");
  return call(env, "POST", `/api/account/${cs}/delete`, { key: dev.pub, sig, at });
}

describe("a suspended account's weather station", () => {
  it("is refused at push time and queues no weather beacon", async () => {
    const w = await world();
    const bad = await user(w.env, "DL1WXB");
    await markCallVerified(w.env, "DL1WXB");
    const key = await weatherStation(w.env, bad.cookie, "DL1WXB", "JN47AB12CD");
    await w.env.DB.prepare("UPDATE wx_keys SET tx_is=1 WHERE key=?").bind(key).run();
    expect((await push(w.env, key)).status).toBe(200);
    expect(await all(w.env, "SELECT kind FROM aprs_outbox WHERE kind='wx'")).toHaveLength(1);

    expect((await suspend(w, "DL1WXB")).status).toBe(200);
    // the beacon queued before the suspension is dropped with the rest of the account's queue
    expect(await all(w.env, "SELECT id FROM aprs_outbox")).toEqual([]);
    await w.env.DB.prepare("UPDATE wx_keys SET last_beacon=0").run();
    const r = await push(w.env, key);
    expect(r.status).toBe(403);
    expect(await all(w.env, "SELECT id FROM aprs_outbox")).toEqual([]);
    expect(await all(w.env, "SELECT ts FROM sensor_readings")).toHaveLength(1);
  });

  it("without coordinates sits at its home locator's 6-character square, however precise the locator", async () => {
    const w = await world();
    const me = await user(w.env, "DL1WXP");
    const key = await weatherStation(w.env, me.cookie, "DL1WXP", "JN47AB12CD");
    const st = await w.env.DB.prepare("SELECT lat, lon FROM account_stations WHERE callsign='DL1WXP-13'").first<{
      lat: number;
      lon: number;
    }>();
    // the centre of JN47AB: 47.0625, 8.0416…
    expect(st!.lat).toBeCloseTo(47.0625, 6);
    expect(st!.lon).toBeCloseTo(8 + 1 / 24, 6);
    // a station row without coordinates is placed the same way at push time
    await w.env.DB.prepare("UPDATE account_stations SET lat=NULL, lon=NULL WHERE callsign='DL1WXP-13'").run();
    expect((await push(w.env, key)).status).toBe(200);
    const map = await w.env.DB.prepare("SELECT lat, lon FROM stations WHERE callsign='DL1WXP-13'").first<{
      lat: number;
      lon: number;
    }>();
    expect(map!.lat).toBeCloseTo(47.0625, 6);
    expect(map!.lon).toBeCloseTo(8 + 1 / 24, 6);
  });
});

describe("a suspension stops what the account had queued", () => {
  it("deletes its queued APRS-IS rows and the Mailbox mail it left, and the box is served neither", async () => {
    const w = await world();
    const bad = await user(w.env, "DL1QUE");
    await markCallVerified(w.env, "DL1QUE");
    await markCallVerified(w.env, "OE1OTH"); // the drain serves only a call still control-verified
    const other = await queue(w.env, "OE1OTH", ":DL1ABC   :hello{1");
    await queue(w.env, "DL1QUE-9", ":DL1ABC   :buy now{2");
    await queue(w.env, SERVICE, ":DL1ABC-7 :de DL1QUE-9: buy now{A1");
    await queue(w.env, SERVICE, ":DL1ABC-7 :de DL1QUEX: not this one{A2");
    const mail = await call(
      w.env,
      "POST",
      "/api/mailbox",
      { from: "DL1QUE", to: "OE5XYZ", text: "buy now" },
      { cookie: bad.cookie },
    );
    expect(mail.status).toBe(201);

    expect((await suspend(w, "DL1QUE")).status).toBe(200);
    expect(await all(w.env, "SELECT id FROM mailbox_messages")).toEqual([]);
    const left = await all<{ src_call: string; payload: string }>(
      w.env,
      "SELECT src_call, payload FROM aprs_outbox ORDER BY id",
    );
    expect(left).toEqual([
      { src_call: "OE1OTH", payload: ":DL1ABC   :hello{1" },
      { src_call: SERVICE, payload: ":DL1ABC-7 :de DL1QUEX: not this one{A2" },
    ]);
    // a row queued after the suspension (by a path that does not check) is never served
    await queue(w.env, "DL1QUE-7", ":DL1ABC   :again{3");
    const served = (await pending(w.env)).items.map((i) => i.src_call);
    expect(served).toEqual(["OE1OTH", SERVICE]);
    expect(await all(w.env, "SELECT id FROM aprs_outbox WHERE src_call='DL1QUE-7'")).toEqual([]);
    expect(other).toBeGreaterThan(0);
  });
});

describe("removing a message", () => {
  it("cancels its queued APRS-IS row, and leaves one already sent", async () => {
    const w = await world();
    const queued = await queue(w.env, "DL1MSG", ":DL1ABC   :rude words{1");
    const sent = await queue(w.env, "DL1MSG", ":DL1ABC   :more rude words{2");
    await w.env.DB.prepare("UPDATE aprs_outbox SET status='sent', sent_at=? WHERE id=?").bind(nowS(), sent).run();
    const ids: number[] = [];
    for (const [outbox, body] of [
      [queued, "rude words"],
      [sent, "more rude words"],
    ] as const) {
      const r = await w.env.DB.prepare(
        "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport, outbox_id) VALUES (?, 'DL1MSG', 'DL1ABC', ?, '1', 'tx', 'aprs-is', ?)",
      )
        .bind(nowS(), body, outbox)
        .run();
      ids.push(Number(r.meta.last_row_id));
    }
    for (const id of ids)
      expect((await sysopCall(w, "POST", "/remove", { kind: "message", id, reason: "abusive message" })).status).toBe(
        200,
      );
    expect(await all(w.env, "SELECT id, status FROM aprs_outbox")).toEqual([{ id: sent, status: "sent" }]);
    expect(await all(w.env, "SELECT id FROM messages")).toEqual([]);
  });
});

describe("a suspension that outlived the erasure of its account", () => {
  it("still keeps the call off the BBS through the ingest box", async () => {
    const w = await world();
    await user(w.env, "DL1ERS");
    expect((await suspend(w, "DL1ERS")).status).toBe(200);
    expect((await signedErase(w.env, "DL1ERS")).status).toBe(200);
    const post = await call(
      w.env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "DL1ERS-5", toCall: "ALL", body: "back again", subject: "hi" },
      { "x-ingest-secret": SECRET },
    );
    expect(post.status).toBe(403);
    expect(post.data.error).toMatch(/suspended/);
    // and a call never suspended still posts
    const ok = await call(
      w.env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "DL1FRE", toCall: "ALL", body: "hello", subject: "hi" },
      { "x-ingest-secret": SECRET },
    );
    expect(ok.status).toBeLessThan(300);
  });
});

describe("erasure and the service call's Mailbox copies", () => {
  it("deletes the message log rows and outbox rows the service call carried for the person, and no one else's", async () => {
    const w = await world();
    await user(w.env, "DL1MBX");
    const log = (from: string, body: string) =>
      w.env.DB.prepare(
        "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, ?, 'OE5XYZ-9', ?, 'tx')",
      )
        .bind(nowS(), from, body)
        .run();
    await log(SERVICE, "de DL1MBX-7: meet at the hut");
    await log(SERVICE, "de DL1MBX: see you");
    await log(SERVICE, "de DL1MBXA: someone else");
    await queue(w.env, SERVICE, ":OE5XYZ-9 :de DL1MBX-7: meet at the hut{B1");
    const sent = await queue(w.env, SERVICE, ":OE5XYZ-9 :de DL1MBX: see you{B2");
    await w.env.DB.prepare("UPDATE aprs_outbox SET status='sent' WHERE id=?").bind(sent).run();
    await queue(w.env, SERVICE, ":OE5XYZ-9 :de DL1MBXA: someone else{B3");
    expect((await signedErase(w.env, "DL1MBX")).status).toBe(200);
    expect(await all(w.env, "SELECT body FROM messages WHERE from_call=?", SERVICE)).toEqual([
      { body: "de DL1MBXA: someone else" },
    ]);
    expect(await all(w.env, "SELECT payload FROM aprs_outbox")).toEqual([
      { payload: ":OE5XYZ-9 :de DL1MBXA: someone else{B3" },
    ]);
  });
});

describe("the Mailbox withdraw", () => {
  it("takes back a held message, and refuses one already sent on the air", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR,OE1ABC", INGEST_SECRET: SECRET });
    const me = await emailSignup(env, "mail@example.test", "OE1ABC");
    await operatorVerify(env, "OE1ABC");
    const leave = async (to: string) =>
      (await call(env, "POST", "/api/mailbox", { from: "OE1ABC", to, text: "hello" }, { cookie: me.cookie })).data
        .id as number;
    const held = await leave("OE5XYZ");
    const sent = await leave("OE6ABC");
    await env.DB.prepare("UPDATE mailbox_messages SET status='sent', attempts=1 WHERE id=?").bind(sent).run();
    expect((await call(env, "DELETE", `/api/mailbox/${sent}`, undefined, { cookie: me.cookie })).status).toBe(409);
    expect((await call(env, "DELETE", `/api/mailbox/${held}`, undefined, { cookie: me.cookie })).status).toBe(200);
    expect((await call(env, "DELETE", `/api/mailbox/${held}`, undefined, { cookie: me.cookie })).status).toBe(404);
    expect(await all(env, "SELECT id FROM mailbox_messages")).toEqual([{ id: sent }]);
  });
});

describe("the account export", () => {
  it("carries the suspension's category, a log's maintenance flag and a sent message's delivery", async () => {
    const w = await world();
    const me = await user(w.env, "DL1EXP");
    await w.env.DB.prepare(
      "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC0EXP', 'OE8APR', 't', 'traditional', 47, 15, 1, 1)",
    ).run();
    await w.env.DB.prepare(
      "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, needs_maintenance) VALUES ((SELECT id FROM caches WHERE code='AC0EXP'), 'DL1EXP', 5, 'note', 1)",
    ).run();
    await w.env.DB.prepare(
      "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport, sent_at, acked_at) VALUES (5, 'DL1EXP', 'DL1ABC', 'hi', '1', 'tx', 'aprs-is', 6, 7)",
    ).run();
    expect((await suspend(w, "DL1EXP")).status).toBe(200);
    // the suspended person exports with their device key; the session ended with the suspension
    const dev = await newFedKey();
    await w.env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,1)")
      .bind("DL1EXP", dev.pub, "phone")
      .run();
    const at = nowS();
    const msg = new TextEncoder().encode(
      accountActionMessage({ action: "export", callsign: "DL1EXP", instance: "gw.test", at }),
    );
    const sig = Buffer.from(await crypto.subtle.sign("Ed25519", dev.priv, msg)).toString("base64url");
    const exp = await call(w.env, "POST", "/api/account/DL1EXP/export", { key: dev.pub, sig, at });
    expect(exp.status).toBe(200);
    expect(exp.data.suspension).toMatchObject({ category: "spam", reason: "sent spam" });
    expect(exp.data.logs).toEqual([expect.objectContaining({ needs_maintenance: 1 })]);
    expect(exp.data.messages).toEqual([expect.objectContaining({ body: "hi", sent_at: 6, acked_at: 7 })]);
    expect(me.status).toBe(200);
  });
});

describe("retention of moderation records, claims and email links", () => {
  it("prunes what has aged out and keeps open reports and a suspension's own log rows", async () => {
    const w = await world();
    await user(w.env, "DL1RET");
    expect((await suspend(w, "DL1RET")).status).toBe(200);
    const now = nowS();
    const old = now - 800 * DAY;
    const report = (status: string, created: number, resolved: number | null) =>
      w.env.DB.prepare(
        "INSERT INTO moderation_reports (target_kind, target_id, category, status, resolved_at, created_at) VALUES ('cache', '1', 'spam', ?, ?, ?)",
      )
        .bind(status, resolved, created)
        .run();
    await report("open", old, null);
    await report("resolved", old, old);
    await report("resolved", old, now - DAY);
    await w.env.DB.prepare(
      "INSERT INTO moderation_log (at, actor_call, action, target_kind, target_id) VALUES (?, 'OE8APR', 'remove', 'cache', '1')",
    )
      .bind(old)
      .run();
    // the suspension's own row, aged past the window, stays while the suspension holds
    await w.env.DB.prepare("UPDATE moderation_log SET at=? WHERE action='suspend'").bind(old).run();
    await w.env.DB.prepare(
      "INSERT INTO callsign_claims (id, token_hash, callsign, status, created_at, completed_at) VALUES ('c1', 'h1', 'DL1OLD', 'done', ?, ?), ('c2', 'h2', 'DL1NEW', 'done', ?, ?)",
    )
      .bind(old, old, now - DAY, now - DAY)
      .run();
    await w.env.DB.prepare(
      "INSERT INTO callsign_events (callsign, action, actor, at) VALUES ('DL1OLD', 'claimed', 'x', ?), ('DL1NEW', 'claimed', 'x', ?)",
    )
      .bind(old, now - DAY)
      .run();
    await w.env.DB.prepare("DELETE FROM email_tokens").run();
    await w.env.DB.prepare(
      "INSERT INTO email_tokens (token, email, purpose, created_at, used) VALUES ('t-used', 'a@x', 'login', ?, 1), ('t-old', 'b@x', 'login', ?, 0), ('t-new', 'c@x', 'login', ?, 0), ('t-fresh-used', 'd@x', 'login', ?, 1)",
    )
      .bind(now - 2 * DAY + 60, now - 3 * DAY, now - 60, now - 60)
      .run();

    await runScheduled(w.env);

    expect(await all(w.env, "SELECT status, resolved_at AS r FROM moderation_reports ORDER BY id")).toEqual([
      { status: "open", r: null },
      { status: "resolved", r: now - DAY },
    ]);
    expect(await all(w.env, "SELECT action FROM moderation_log WHERE at=?", old)).toEqual([{ action: "suspend" }]);
    expect(await all(w.env, "SELECT id FROM callsign_claims")).toEqual([{ id: "c2" }]);
    expect(await all(w.env, "SELECT callsign FROM callsign_events")).toEqual([{ callsign: "DL1NEW" }]);
    expect(await all(w.env, "SELECT token FROM email_tokens ORDER BY token")).toEqual([
      { token: "t-fresh-used" },
      { token: "t-new" },
    ]);
  });

  it("reads its window from MODERATION_RETENTION_DAYS", async () => {
    const w = await world();
    (w.env as Record<string, unknown>).MODERATION_RETENTION_DAYS = "10";
    await w.env.DB.prepare(
      "INSERT INTO moderation_log (at, actor_call, action, target_kind, target_id) VALUES (?, 'OE8APR', 'remove', 'cache', '1'), (?, 'OE8APR', 'remove', 'cache', '2')",
    )
      .bind(nowS() - 11 * DAY, nowS() - 9 * DAY)
      .run();
    await runScheduled(w.env);
    expect(await all(w.env, "SELECT target_id FROM moderation_log")).toEqual([{ target_id: "2" }]);
  });
});
