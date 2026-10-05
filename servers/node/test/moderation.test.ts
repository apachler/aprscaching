// SPDX-License-Identifier: AGPL-3.0-or-later
// Moderation on a public instance: players report content, the sysop removes it or suspends the account behind
// it, every action lands in the audit log, and removed content leaves public reads, feeds, exports and the
// federation (through a signed tombstone). Only the sysop reaches any of it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { addCache, instanceEnv, newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

interface World {
  env: Env;
  sysop: Res;
}

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

async function world(extra: Record<string, unknown> = {}): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", HIDE_DAILY_LIMIT: "50", ...extra });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

async function user(w: World, cs: string): Promise<Res> {
  const s = await emailSignup(w.env, `${cs.toLowerCase()}@example.test`, cs, nextIp());
  expect(s.status).toBe(200);
  // hiding a cache takes a verified call: the sysop verifies each player by hand
  const v = await call(
    w.env,
    "POST",
    "/api/admin/verifications",
    {
      callsign: cs,
      note: "licence checked",
      holder: (await w.env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
        .bind(cs)
        .first<{ account_id: string }>())!.account_id,
    },
    { cookie: w.sysop.cookie },
  );
  expect(v.status).toBe(201);
  return s;
}

const as = (r: Res) => ({ cookie: r.cookie });
const sysopCall = (w: World, method: string, path: string, body?: unknown) =>
  call(w.env, method, `/api/admin/moderation${path}`, body, as(w.sysop));

async function hide(w: World, owner: Res, title = "under the oak"): Promise<{ id: number; code: string }> {
  const r = await call(
    w.env,
    "POST",
    "/api/caches",
    { title, type: "traditional", lat: 47.1, lon: 15.4, description: "a box" },
    as(owner),
  );
  expect(r.status).toBe(201);
  return { id: r.data.cache.id as number, code: r.data.cache.code as string };
}

async function addLog(env: Env, cacheId: number, logger: string, type = "note", comment = "hello"): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, comment) VALUES (?,?,?,?,0,?)",
  )
    .bind(cacheId, logger, 1000, type, comment)
    .run();
  return Number(r.meta.last_row_id);
}

const tombstones = async (env: Env) =>
  (await env.DB.prepare("SELECT kind, target_id FROM tombstones").all<{ kind: string; target_id: string }>()).results;
const auditRows = async (env: Env) =>
  (
    await env.DB.prepare(
      "SELECT action, target_kind, target_id, actor_call, reason FROM moderation_log ORDER BY id",
    ).all<{
      action: string;
      target_kind: string;
      target_id: string;
      actor_call: string;
      reason: string | null;
    }>()
  ).results;

describe("the moderation routes are the sysop's alone", () => {
  it("refuses a signed-in player and an anonymous caller on every route", async () => {
    const w = await world();
    const u = await user(w, "DL1USR");
    const { id } = await hide(w, u);
    const routes: [string, string, unknown?][] = [
      ["GET", "/reports"],
      ["POST", "/reports/1", { status: "resolved" }],
      ["POST", "/remove", { kind: "cache", id, reason: "spam listing" }],
      ["POST", "/restore", { kind: "cache", id, reason: "mistake" }],
      ["GET", "/accounts?q=DL"],
      ["GET", "/accounts/DL1USR"],
      ["POST", "/accounts/DL1USR/suspend", { reason: "abuse" }],
      ["POST", "/accounts/DL1USR/unsuspend", { reason: "ok" }],
      ["GET", "/log"],
    ];
    for (const h of [as(u), {}])
      for (const [m, p, b] of routes)
        expect((await call(w.env, m, `/api/admin/moderation${p}`, b, h)).status, `${m} ${p}`).toBe(403);
    expect(await auditRows(w.env)).toEqual([]);
    const c = await w.env.DB.prepare("SELECT removed_at FROM caches WHERE id=?")
      .bind(id)
      .first<{ removed_at: number | null }>();
    expect(c!.removed_at).toBeNull();
  });

  it("takes the operator secret for scripted moderation", async () => {
    const w = await world();
    const r = await call(w.env, "GET", "/api/admin/moderation/log", undefined, {
      "x-operator-secret": "test-operator-secret",
    });
    expect(r.status).toBe(200);
  });
});

describe("reports", () => {
  it("stores a report, emails the operator, and lists it for the sysop without telling the reported person", async () => {
    const w = await world({ OPERATOR_EMAIL: "abuse@example.test" });
    const owner = await user(w, "DL1OWN");
    const reporter = await user(w, "DL1REP");
    const { id } = await hide(w, owner);
    // mail is configured once the sign-ups are done, so the report goes out by email
    const sent: { to: string; subject: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)) as { to: string; subject: string });
        return new Response("{}", { status: 200 });
      }),
    );
    Object.assign(w.env, { EMAIL_API_KEY: "k", EMAIL_FROM: "gw@example.test" });

    const r = await call(
      w.env,
      "POST",
      "/api/reports",
      { kind: "cache", id, category: "unsafe", text: "on a cliff edge" },
      as(reporter),
    );
    expect(r.status).toBe(201);
    const again = await call(w.env, "POST", "/api/reports", { kind: "cache", id, category: "unsafe" }, as(reporter));
    expect(again.data).toMatchObject({ ok: true, duplicate: true, id: r.data.id });
    expect(sent.filter((m) => m.to === "abuse@example.test")).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/unsafe/);

    const list = await sysopCall(w, "GET", "/reports");
    expect(list.status).toBe(200);
    expect(list.data.counts.open).toBe(1);
    expect(list.data.reports[0]).toMatchObject({
      kind: "cache",
      targetId: String(id),
      category: "unsafe",
      text: "on a cliff edge",
      reporter: "DL1REP",
      cacheId: id,
      gone: false,
    });
    // the owner's own reads carry nothing about it
    const detail = await call(w.env, "GET", `/api/caches/${id}`, undefined, as(owner));
    expect(JSON.stringify(detail.data)).not.toMatch(/DL1REP|cliff edge/);

    const resolved = await sysopCall(w, "POST", `/reports/${r.data.id}`, { status: "resolved", note: "checked, fine" });
    expect(resolved.status).toBe(200);
    expect((await sysopCall(w, "GET", "/reports")).data.counts).toEqual({ open: 0, resolved: 1 });
    expect((await auditRows(w.env)).at(-1)).toMatchObject({ action: "resolve", target_kind: "report" });
  });

  it("validates the kind, the category and the target", async () => {
    const w = await world();
    const u = await user(w, "DL1REP");
    expect((await call(w.env, "POST", "/api/reports", { kind: "nope", id: 1, category: "spam" }, as(u))).status).toBe(
      400,
    );
    expect((await call(w.env, "POST", "/api/reports", { kind: "cache", id: 1, category: "rude" }, as(u))).status).toBe(
      400,
    );
    expect(
      (await call(w.env, "POST", "/api/reports", { kind: "cache", id: 999, category: "spam" }, as(u))).status,
    ).toBe(404);
    expect(
      (await call(w.env, "POST", "/api/reports", { kind: "profile", id: "OE8APR", category: "other" }, as(u))).status,
    ).toBe(400);
  });

  it("throttles signed-out reports per address and signed-in reports per account", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const caches = [];
    for (let i = 0; i < 12; i++) caches.push((await hide(w, owner, `cache ${i}`)).id);
    const anon = (id: number) =>
      call(w.env, "POST", "/api/reports", { kind: "cache", id, category: "spam" }, {}, "203.0.113.7");
    for (let i = 0; i < 3; i++) expect((await anon(caches[i]!)).status).toBe(201);
    expect((await anon(caches[3]!)).status).toBe(429);

    const u = await user(w, "DL1REP");
    const signed = (id: number) =>
      call(w.env, "POST", "/api/reports", { kind: "cache", id, category: "spam" }, as(u), "203.0.113.8");
    for (let i = 0; i < 10; i++) expect((await signed(caches[i]!)).status).toBe(201);
    expect((await signed(caches[10]!)).status).toBe(429);
  });
});

describe("removing a cache", () => {
  it("hides it from public reads, feeds and exports, tombstones it, tells the owner, and blocks edits", async () => {
    const w = await world({ FED_ENABLED: "1" });
    const owner = await user(w, "DL1OWN");
    const { id, code } = await hide(w, owner);
    const reporter = await user(w, "DL1REP");
    const rep = await call(w.env, "POST", "/api/reports", { kind: "cache", id, category: "spam" }, as(reporter));
    await addLog(w.env, id, "DL1FND", "note", "was here");
    expect(JSON.stringify((await call(w.env, "GET", "/api/activity")).data)).toContain(code);

    expect((await sysopCall(w, "POST", "/remove", { kind: "cache", id })).status).toBe(400); // a reason is required
    const r = await sysopCall(w, "POST", "/remove", { kind: "cache", id, reason: "advertising listing" });
    expect(r.status).toBe(200);
    expect(r.data.tombstones).toBe(1);
    expect(await tombstones(w.env)).toEqual([{ kind: "cache", target_id: `gw.test:cache:${id}` }]);
    expect((await sysopCall(w, "POST", "/remove", { kind: "cache", id, reason: "again" })).status).toBe(409);

    // public reads
    expect((await call(w.env, "GET", `/api/caches/${id}`)).status).toBe(410);
    expect((await call(w.env, "GET", `/api/caches/${id}`, undefined, as(reporter))).status).toBe(410);
    expect((await call(w.env, "GET", `/api/caches/${id}/logs`)).status).toBe(410);
    expect((await call(w.env, "GET", `/api/caches/${id}/media`)).status).toBe(410);
    expect(JSON.stringify((await call(w.env, "GET", "/api/activity")).data)).not.toContain(code);
    const map = await call(w.env, "GET", "/api/caches?bbox=15,47,16,48");
    expect(map.data.caches.map((c: { code: string }) => c.code)).not.toContain(code);
    expect((await call(w.env, "GET", `/api/v1/caches/${code}.gpx`)).status).toBe(404);
    const fed = await call(w.env, "GET", "/federation/caches?since=0");
    expect(JSON.stringify(fed.data)).not.toContain(`gw.test:cache:${id}`);
    const tsFeed = await call(w.env, "GET", "/federation/tombstones?since=0");
    expect(JSON.stringify(tsFeed.data)).toContain(`gw.test:cache:${id}`);

    // the owner and the sysop still see it, marked
    const own = await call(w.env, "GET", `/api/caches/${id}`, undefined, as(owner));
    expect(own.status).toBe(200);
    expect(own.data.cache.removed).toMatchObject({ reason: "advertising listing" });
    expect(own.data.cache.status).toBe("archived");
    expect((await call(w.env, "GET", `/api/caches/${id}`, undefined, as(w.sysop))).status).toBe(200);
    const edit = await call(w.env, "PATCH", `/api/caches/${id}`, { status: "active" }, as(owner));
    expect(edit.status).toBe(403);

    // the owner is told, the report is settled, the action is audited
    const alerts = await call(w.env, "GET", "/api/watch/alerts", undefined, as(owner));
    expect(JSON.stringify(alerts.data)).toMatch(/advertising listing/);
    const reports = await sysopCall(w, "GET", "/reports?status=resolved");
    expect(reports.data.reports.map((x: { id: number }) => x.id)).toContain(rep.data.id);
    expect(await auditRows(w.env)).toContainEqual(
      expect.objectContaining({ action: "remove", target_kind: "cache", target_id: String(id), actor_call: "OE8APR" }),
    );

    // restore brings it back disabled, for the owner to enable
    expect((await sysopCall(w, "POST", "/restore", { kind: "cache", id, reason: "owner fixed it" })).status).toBe(200);
    const back = await call(w.env, "GET", `/api/caches/${id}`);
    expect(back.status).toBe(200);
    expect(back.data.cache.status).toBe("disabled");
    expect(back.data.cache.removed).toBeUndefined();
  });
});

describe("removing a single item", () => {
  it("deletes a log, tombstones it, and drops it from the logbook", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const { id } = await hide(w, owner);
    const logId = await addLog(w.env, id, "DL1BAD", "note", "offensive words");
    expect((await call(w.env, "GET", `/api/caches/${id}/logs`)).data.logs).toHaveLength(1);
    const r = await sysopCall(w, "POST", "/remove", { kind: "log", id: logId, reason: "offensive note" });
    expect(r.status).toBe(200);
    expect((await call(w.env, "GET", `/api/caches/${id}/logs`)).data.logs).toHaveLength(0);
    expect(await tombstones(w.env)).toContainEqual({ kind: "find", target_id: `gw.test:find:${logId}` });
    expect((await sysopCall(w, "POST", "/remove", { kind: "log", id: logId, reason: "again" })).status).toBe(404);
  });

  it("deletes a media item with its stored objects", async () => {
    const deleted: string[] = [];
    const w = await world({ MEDIA: { delete: async (k: string) => void deleted.push(k) } });
    const owner = await user(w, "DL1OWN");
    const { id } = await hide(w, owner);
    const m = await w.env.DB.prepare(
      "INSERT INTO cache_media (cache_id, media_key, kind, content_type, bytes, created_at, thumb_key) VALUES (?, 'k1', 'image', 'image/jpeg', 10, 1, 't1')",
    )
      .bind(id)
      .run();
    const mediaId = Number(m.meta.last_row_id);
    expect(
      (await sysopCall(w, "POST", "/remove", { kind: "media", id: mediaId, reason: "copyrighted photo" })).status,
    ).toBe(200);
    expect((await call(w.env, "GET", `/api/caches/${id}/media`)).data.media).toEqual([]);
    expect(deleted.sort()).toEqual(["k1", "t1"]);
  });

  it("deletes messages of every kind, tombstoning only this instance's own bulletins", async () => {
    const w = await world();
    const db = w.env.DB;
    const ins = async (sql: string) => Number((await db.prepare(sql).run()).meta.last_row_id);
    const msg = await ins(
      "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (1, 'DL1BAD', 'OE1X', 'spam', 'rx')",
    );
    const bull = await ins(
      "INSERT INTO bbs_messages (bid, type, from_call, to_call, body, posted_at) VALUES ('1_gw', 'B', 'DL1BAD', 'ALL', 'spam', 1)",
    );
    const mirrored = await ins(
      "INSERT INTO bbs_messages (bid, type, from_call, to_call, body, posted_at, origin) VALUES ('peer.test:bulletin:5', 'B', 'DL2X', 'ALL', 'spam', 1, 'peer.test')",
    );
    const mail = await ins(
      "INSERT INTO mailbox_messages (from_call, from_account, to_call, body, via, created_at, expires_at) VALUES ('DL1BAD', 'a', 'OE1X', 'spam', 'app', 1, 9999999999)",
    );
    const mesh = await ins(
      "INSERT INTO meshcom_group_messages (ts, from_call, grp, body, dedup_key) VALUES (1, 'DL1BAD', '*', 'spam', 'd1')",
    );
    for (const [kind, id] of [
      ["message", msg],
      ["bbs", bull],
      ["bbs", mirrored],
      ["mailbox", mail],
      ["meshcom", mesh],
    ] as const)
      expect((await sysopCall(w, "POST", "/remove", { kind, id, reason: "spam flood" })).status, kind).toBe(200);
    for (const t of ["messages", "bbs_messages", "mailbox_messages", "meshcom_group_messages"])
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n, t).toBe(0);
    expect(await tombstones(w.env)).toEqual([{ kind: "bulletin", target_id: `gw.test:bulletin:${bull}` }]);
    // the mirrored copy is suppressed against its origin's id, so a later sync does not bring it back
    const sup = await db
      .prepare("SELECT origin FROM remote_tombstones WHERE target_id='peer.test:bulletin:5'")
      .first<{ origin: string }>();
    expect(sup?.origin).toBe("peer.test");
  });

  it("clears a profile's self-written fields and keeps the account", async () => {
    const w = await world();
    const u = await user(w, "DL1USR");
    await call(w.env, "POST", "/auth/profile", { displayName: "Rude Name", bio: "rude bio" }, as(u));
    expect(
      (await sysopCall(w, "POST", "/remove", { kind: "profile", id: "DL1USR", reason: "offensive bio" })).status,
    ).toBe(200);
    const row = await w.env.DB.prepare("SELECT display_name, bio FROM accounts WHERE callsign='DL1USR'").first();
    expect(row).toEqual({ display_name: null, bio: null });
  });
});

describe("removal reaches the federation", () => {
  it("purges a peer's mirrored cache, find and bulletin through the tombstone feed", async () => {
    const key = await newFedKey();
    const a = instanceEnv("a.example", key);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES ('https://a.example', 'a.example', ?, 'trusted', 'manual')",
    )
      .bind(key.pub)
      .run();
    const cacheId = await addCache(a, Math.floor(Date.now() / 1000) - 60);
    const logId = await addLog(a, cacheId, "DL1FND", "found", "nice");
    const now = Math.floor(Date.now() / 1000);
    const bull = Number(
      (
        await a.DB.prepare(
          "INSERT INTO bbs_messages (bid, type, from_call, to_call, body, posted_at) VALUES ('7_a', 'B', 'DL1BAD', 'ALL', 'spam', ?)",
        )
          .bind(now - 30)
          .run()
      ).meta.last_row_id,
    );
    stubFetch({ "https://a.example": serve(a) });
    await syncAllPeers(hub);
    const count = async (sql: string) => (await hub.DB.prepare(sql).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM remote_caches")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM remote_finds")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM bbs_messages WHERE origin='a.example'")).toBe(1);

    const op = { "x-operator-secret": "test-operator-secret" };
    for (const [kind, id] of [
      ["log", logId],
      ["bbs", bull],
      ["cache", cacheId],
    ] as const)
      expect((await call(a, "POST", "/api/admin/moderation/remove", { kind, id, reason: "takedown" }, op)).status).toBe(
        200,
      );
    expect((await auditRows(a)).map((r) => r.actor_call)).toEqual(["OPERATOR", "OPERATOR", "OPERATOR"]);

    await syncAllPeers(hub);
    expect(await count("SELECT COUNT(*) AS n FROM remote_caches")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM remote_finds")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM bbs_messages WHERE origin='a.example'")).toBe(0);
  });
});

describe("suspension", () => {
  it("ends the sessions, refuses sign-in and writes, and lifts again", async () => {
    const w = await world();
    const u = await user(w, "DL1BAD");
    const { id } = await hide(w, u);
    expect((await call(w.env, "GET", "/auth/session", undefined, as(u))).data.callsign).toBe("DL1BAD");

    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/suspend", { reason: "x" })).status).toBe(400);
    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/suspend", { reason: "spam", until: 5 })).status).toBe(400);
    const s = await sysopCall(w, "POST", "/accounts/DL1BAD/suspend", { reason: "repeated spam" });
    expect(s.status).toBe(200);

    // the old session is gone, writes are refused, and a new sign-in is refused with the reason
    expect((await call(w.env, "GET", "/auth/session", undefined, as(u))).data.callsign).toBeNull();
    expect(
      (await call(w.env, "POST", "/api/caches", { title: "t", type: "traditional", lat: 47, lon: 15 }, as(u))).status,
    ).toBe(401);
    const signIn = await emailSignup(w.env, "dl1bad@example.test", "DL1BAD", nextIp());
    expect(signIn.status).toBe(403);
    expect(signIn.data.error).toMatch(/suspended.*repeated spam/);
    expect(signIn.cookie).toBe("");

    // the ingest plane cannot log or post in the suspended call's name either
    const ingest = { "x-ingest-secret": "test-ingest-secret" };
    const owner2 = await user(w, "DL1OTH");
    const other = await hide(w, owner2, "elsewhere");
    const radioFind = await call(
      w.env,
      "POST",
      `/api/caches/${other.id}/logs`,
      { logType: "note", loggerCall: "DL1BAD", comment: "hi" },
      ingest,
    );
    expect(radioFind.status).toBe(409);
    expect(radioFind.data.error).toMatch(/suspended/);
    const bbs = await call(
      w.env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "DL1BAD", toCall: "ALL", body: "spam" },
      ingest,
    );
    expect(bbs.status).toBe(403);

    // public content stays
    expect((await call(w.env, "GET", `/api/caches/${id}`)).status).toBe(200);

    const listed = await sysopCall(w, "GET", "/accounts?suspended=1");
    expect(listed.data.accounts[0]).toMatchObject({ callsign: "DL1BAD", suspended: { reason: "repeated spam" } });
    const detail = await sysopCall(w, "GET", "/accounts/DL1BAD");
    expect(detail.data.content.map((c: { kind: string }) => c.kind)).toContain("cache");
    expect(detail.data.actions[0]).toMatchObject({ action: "suspend" });

    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/unsuspend", { reason: "appeal accepted" })).status).toBe(200);
    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/unsuspend", { reason: "again" })).status).toBe(409);
    const back = await emailSignup(w.env, "dl1bad@example.test", "DL1BAD", nextIp());
    expect(back.status).toBe(200);

    // the person's export carries what was done about their account
    const exp = await call(w.env, "POST", "/api/account/DL1BAD/export", {}, as(back));
    expect(exp.data.moderationActions.map((a: { action: string }) => a.action)).toEqual(["suspend", "unsuspend"]);
  });

  it("refuses passkey-less sign-in while a dated suspension holds and lets it lapse", async () => {
    const w = await world();
    await user(w, "DL1TMP");
    const until = Math.floor(Date.now() / 1000) + 3600;
    expect((await sysopCall(w, "POST", "/accounts/DL1TMP/suspend", { reason: "cool down", until })).status).toBe(200);
    expect((await emailSignup(w.env, "dl1tmp@example.test", "DL1TMP", nextIp())).status).toBe(403);
    await w.env.DB.prepare("UPDATE account_suspensions SET until=? WHERE 1")
      .bind(Math.floor(Date.now() / 1000) - 1)
      .run();
    expect((await emailSignup(w.env, "dl1tmp@example.test", "DL1TMP", nextIp())).status).toBe(200);
  });

  it("never suspends an operator's account", async () => {
    const w = await world();
    expect((await sysopCall(w, "POST", "/accounts/OE8APR/suspend", { reason: "self lock-out" })).status).toBe(409);
  });
});

describe("the audit log", () => {
  it("lists every action newest first, with paging", async () => {
    const w = await world();
    const u = await user(w, "DL1USR");
    const { id } = await hide(w, u);
    for (let i = 0; i < 3; i++) await addLog(w.env, id, "DL1X", "note", `n${i}`);
    const logs = (await w.env.DB.prepare("SELECT id FROM cache_logs").all<{ id: number }>()).results;
    for (const l of logs) await sysopCall(w, "POST", "/remove", { kind: "log", id: l.id, reason: "cleanup" });
    const page = await sysopCall(w, "GET", "/log?limit=2");
    expect(page.data.entries).toHaveLength(2);
    expect(page.data.entries[0].id).toBeGreaterThan(page.data.entries[1].id);
    const rest = await sysopCall(w, "GET", `/log?limit=2&before=${page.data.nextBefore}`);
    expect(rest.data.entries).toHaveLength(1);
    expect(rest.data.nextBefore).toBeNull();
  });

  it("keeps its rows after the person erases their account and drops the reporter from their reports", async () => {
    const w = await world();
    const owner = await user(w, "DL1OWN");
    const rep = await user(w, "DL1REP");
    const { id } = await hide(w, owner);
    await call(w.env, "POST", "/api/reports", { kind: "cache", id, category: "spam" }, as(rep));
    await sysopCall(w, "POST", "/accounts/DL1OWN/suspend", { reason: "spam" });
    expect((await call(w.env, "POST", "/api/account/DL1REP/delete", {}, as(rep))).status).toBe(200);
    const report = await w.env.DB.prepare("SELECT reporter_account, reporter_call FROM moderation_reports").first();
    expect(report).toEqual({ reporter_account: null, reporter_call: null });
    expect((await auditRows(w.env)).map((a) => a.action)).toEqual(["suspend"]);
  });
});
