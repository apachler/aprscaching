// SPDX-License-Identifier: AGPL-3.0-or-later
// Erasure and removal hold under failure and reach every row that names the person: an erasure or a sysop's
// removal commits with its tombstones or not at all, uploads leave the store even after a crash, a suspended
// person still exports and erases, and the call leaves the IGate credits, the telemetry rings, others'
// watchlists, the tool registries and the offline pack. Missing deletions are never given up, and the
// federation's working tables are bounded.
import { describe, it, expect } from "vitest";
import { runScheduled } from "@aprscaching/gateway/app";
import { giveUpGaps } from "@aprscaching/gateway/fedgaps";
import { authEnv, call, emailSignup, markCallVerified, type Res } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const nowS = () => Math.floor(Date.now() / 1000);
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;
const OP = { "x-operator-secret": "test-operator-secret" };

async function person(env: Env, cs: string): Promise<Res & { acct: string }> {
  const s = await emailSignup(env, `${cs.toLowerCase()}@example.test`, cs, nextIp());
  expect(s.status).toBe(200);
  const acct = (await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string }>())!.account_id;
  return { ...s, acct };
}

const one = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>())!;
const n = async (env: Env, sql: string, ...binds: unknown[]) => (await one<{ n: number }>(env, sql, ...binds)).n;
const exec = async (env: Env, sql: string, ...binds: unknown[]) => {
  await env.DB.prepare(sql)
    .bind(...binds)
    .run();
};

async function cacheAt(env: Env, owner: string, code = "AC-ER1"): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO caches (code, owner_call, title, type, lat, lon, description, created_at, updated_at)
     VALUES (?, ?, 'oak', 'traditional', 47.1, 15.1, 'by the oak', 100, 100)`,
  )
    .bind(code, owner)
    .run();
  return Number(r.meta.last_row_id);
}

async function logOn(env: Env, cacheId: number, logger: string, extra: { igate?: string; tier?: string } = {}) {
  const r = await env.DB.prepare(
    `INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier, comment, corroborator_igate)
     VALUES (?, ?, ?, 'found', 1, ?, 'tftc', ?)`,
  )
    .bind(cacheId, logger, nowS() - 60, extra.tier ?? "A", extra.igate ?? null)
    .run();
  return Number(r.meta.last_row_id);
}

/** Make every write to `table` fail until the returned function lifts it. */
async function breakTable(env: Env, table: string): Promise<() => Promise<void>> {
  await exec(env, `CREATE TRIGGER broken_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'down'); END`);
  return () => exec(env, `DROP TRIGGER broken_${table}`);
}

const erase = async (env: Env, p: { cookie: string }, cs: string) => {
  try {
    return await call(env, "POST", `/api/account/${cs}/delete`, {}, { cookie: p.cookie });
  } catch {
    return { status: 500, data: null, cookie: "" };
  }
};

describe("erasure is crash-safe", () => {
  it("a failed erasure changes nothing, and asking again finishes it with its tombstones", async () => {
    const env = authEnv();
    const p = await person(env, "DL1ERA");
    const cacheId = await cacheAt(env, "OE8OWN");
    const logId = await logOn(env, cacheId, "DL1ERA-7");
    const fedSeq = (await one<{ fed_seq: number }>(env, "SELECT fed_seq FROM cache_logs WHERE id=?", logId)).fed_seq;

    const lift = await breakTable(env, "tombstones");
    expect((await erase(env, p, "DL1ERA")).status).not.toBe(200);
    // nothing was rewritten: the find still names the call and the account is still there
    expect(
      (await one<{ logger_call: string }>(env, "SELECT logger_call FROM cache_logs WHERE id=?", logId)).logger_call,
    ).toBe("DL1ERA-7");
    expect(await n(env, "SELECT COUNT(*) AS n FROM accounts WHERE account_id=?", p.acct)).toBe(1);

    await lift();
    const done = await erase(env, p, "DL1ERA");
    expect(done.status).toBe(200);
    expect(done.data.tombstones).toBeGreaterThanOrEqual(1);
    expect(
      await n(env, "SELECT COUNT(*) AS n FROM tombstones WHERE kind='find' AND target_id=?", `gw.test:find:${fedSeq}`),
    ).toBe(1);
    expect(
      (await one<{ logger_call: string }>(env, "SELECT logger_call FROM cache_logs WHERE id=?", logId)).logger_call,
    ).toMatch(/^WITHDRAWN#/);
  });

  it("an upload the store refuses to delete stays queued until the nightly job deletes it", async () => {
    const deleted: string[] = [];
    let refuse = true;
    const media = {
      put: async () => {},
      get: async () => null,
      delete: async (k: string) => {
        if (refuse) throw new Error("store down");
        deleted.push(k);
      },
    };
    const env = authEnv({ MEDIA: media });
    const p = await person(env, "DL1MED");
    const cacheId = await cacheAt(env, "DL1MED");
    await exec(
      env,
      "INSERT INTO cache_media (cache_id, media_key, kind, content_type, bytes, created_at) VALUES (?, 'media/er-1', 'image', 'image/png', 3, 1)",
      cacheId,
    );
    expect((await erase(env, p, "DL1MED")).status).toBe(200);
    expect(deleted).toEqual([]);
    expect(await n(env, "SELECT COUNT(*) AS n FROM media_deletions WHERE media_key='media/er-1'")).toBe(1);
    refuse = false;
    await runScheduled(env);
    expect(deleted).toEqual(["media/er-1"]);
    expect(await n(env, "SELECT COUNT(*) AS n FROM media_deletions")).toBe(0);
  });

  it("a sysop's removal whose tombstone cannot be written leaves the item in place", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const cacheId = await cacheAt(env, "OE8OWN");
    const logId = await logOn(env, cacheId, "DL1LOG");
    const lift = await breakTable(env, "tombstones");
    const remove = () =>
      call(
        env,
        "POST",
        "/api/admin/moderation/remove",
        { kind: "log", id: String(logId), reason: "off-topic log" },
        OP,
      ).catch(() => ({ status: 500 }));
    expect((await remove()).status).not.toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM cache_logs WHERE id=?", logId)).toBe(1);
    await lift();
    expect((await remove()).status).toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM cache_logs WHERE id=?", logId)).toBe(0);
    expect(await n(env, "SELECT COUNT(*) AS n FROM tombstones WHERE kind='find'")).toBe(1);
  });
});

describe("a suspended person keeps export and erasure", () => {
  it("opens a data link, exports and erases, and the data session does nothing else", async () => {
    const env = authEnv();
    const p = await person(env, "DL1SUS");
    const s = await call(
      env,
      "POST",
      "/api/admin/moderation/accounts/DL1SUS/suspend",
      { reason: "spam listings", category: "spam" },
      OP,
    );
    expect(s.status).toBe(200);
    const start = await call(env, "POST", "/auth/email/start", {
      email: "dl1sus@example.test",
      purpose: "account-data",
    });
    expect(start.status).toBe(200);
    const open = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect(open.status).toBe(200);
    expect(open.data.accountData).toBe(true);
    const cookie = { cookie: open.cookie };
    // the data session is no sign-in: it writes nothing
    const hide = await call(env, "POST", "/api/caches", { title: "x", type: "traditional", lat: 47, lon: 15 }, cookie);
    expect([401, 403]).toContain(hide.status);
    const exp = await call(env, "POST", "/api/account/me/export", {}, cookie);
    expect(exp.status).toBe(200);
    expect(exp.data.account.callsign).toBe("DL1SUS");
    expect(exp.data.suspension).toMatchObject({ category: "spam" });
    expect((await call(env, "POST", "/api/account/me/delete", {}, cookie)).status).toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM accounts WHERE account_id=?", p.acct)).toBe(0);
  });
});

describe("erasure reaches every row that names the call", () => {
  it("tombstones the person's own bulletins before deleting them", async () => {
    const env = authEnv();
    const p = await person(env, "DL1BUL");
    await exec(
      env,
      "INSERT INTO bbs_messages (id, type, from_call, to_call, subject, body, posted_at) VALUES (77, 'B', 'DL1BUL', 'ALL', 'qrv', 'hi', ?)",
      nowS(),
    );
    expect((await erase(env, p, "DL1BUL")).status).toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM bbs_messages WHERE id=77")).toBe(0);
    expect(
      await n(env, "SELECT COUNT(*) AS n FROM tombstones WHERE kind='bulletin' AND target_id='gw.test:bulletin:77'"),
    ).toBe(1);
  });

  it("drops the call as the IGate of others' finds, positions and stations, and from the IGate ranking", async () => {
    const env = authEnv();
    const p = await person(env, "DL1IGT");
    const cacheId = await cacheAt(env, "OE8OWN");
    const other = await logOn(env, cacheId, "OE5OTH", { igate: "DL1IGT-10" });
    await exec(
      env,
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, transport) VALUES ('OE5OTH-9', ?, 47, 15, 'rf', 'DL1IGT-10', 'tnc')",
      nowS(),
    );
    await exec(
      env,
      "INSERT INTO stations (callsign, lat, lon, last_seen, source_call) VALUES ('OE5OTH-9', 47, 15, ?, 'DL1IGT-10')",
      nowS(),
    );
    expect(
      (await call(env, "GET", "/api/corroborators")).data.corroborators.map((c: { igate: string }) => c.igate),
    ).toEqual(["DL1IGT-10"]);
    expect((await erase(env, p, "DL1IGT")).status).toBe(200);
    expect(
      await one(env, "SELECT corroborator_igate AS c, logger_call AS l FROM cache_logs WHERE id=?", other),
    ).toEqual({
      c: null,
      l: "OE5OTH",
    });
    expect(await n(env, "SELECT COUNT(*) AS n FROM positions WHERE igate_call LIKE 'DL1IGT%'")).toBe(0);
    expect(await n(env, "SELECT COUNT(*) AS n FROM stations WHERE source_call LIKE 'DL1IGT%'")).toBe(0);
    expect(await n(env, "SELECT COUNT(*) AS n FROM positions WHERE callsign='OE5OTH-9'")).toBe(1);
    expect((await call(env, "GET", "/api/corroborators")).data.corroborators).toEqual([]);
  });

  it("removes the call from the telemetry rings and from others' watchlists", async () => {
    const env = authEnv();
    const p = await person(env, "DL1TEL");
    const watcher = await person(env, "OE5WAT");
    const t = nowS();
    const seed: Array<[string, ...unknown[]]> = [
      [
        "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via) VALUES ('DL1TEL-9', ?, 'APRS', 'WIDE1-1', '!x', 'rf')",
        t,
      ],
      [
        "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via) VALUES ('OE5XYZ', ?, 'APRS', 'OE8DIG*,DL1TEL-10*,WIDE2-1', '!y', 'rf')",
        t,
      ],
      [
        "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via) VALUES ('OE5XYZ', ?, 'APRS', 'WIDE1-1', '!z', 'rf')",
        t,
      ],
      ["INSERT INTO sensor_readings (station, ts, temp_c, source) VALUES ('DL1TEL-13', ?, 20, 'rf')", t],
      [
        "INSERT INTO meshcom_nodes (callsign, last_heard, last_via, updated_at) VALUES ('DL1TEL-12', ?, 'direct', ?)",
        t,
        t,
      ],
      [
        "INSERT INTO meshcom_links (from_call, to_call, kind, last_seen, updated_at) VALUES ('DL1TEL-12', 'OE5XYZ-12', 'direct', ?, ?)",
        t,
        t,
      ],
      ["INSERT INTO node_mheard (callsign, port, last_heard) VALUES ('DL1TEL-9', 'vhf', ?)", t],
      ["INSERT INTO watch_calls (account_id, callsign, added_at) VALUES (?, 'DL1TEL', ?)", watcher.acct, t],
      [
        "INSERT INTO watch_alerts (account_id, callsign, kind, lat, lon, ts) VALUES (?, 'DL1TEL-9', 'heard', 47.1, 15.1, ?)",
        watcher.acct,
        t,
      ],
    ];
    for (const [sql, ...b] of seed) await exec(env, sql, ...b);
    expect((await erase(env, p, "DL1TEL")).status).toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM packets_recent")).toBe(1);
    for (const [table, col] of [
      ["sensor_readings", "station"],
      ["meshcom_nodes", "callsign"],
      ["meshcom_links", "from_call"],
      ["node_mheard", "callsign"],
      ["watch_calls", "callsign"],
      ["watch_alerts", "callsign"],
    ])
      expect(await n(env, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE 'DL1TEL%'`), table).toBe(0);
  });

  it("clears the call that added an instance-wide tool registry", async () => {
    const env = authEnv();
    const p = await person(env, "DL1REG");
    await exec(
      env,
      `INSERT INTO tool_registries (id, account_id, spec, url, authority, label, created_at, confirmed_at, added_by)
       VALUES ('r1', NULL, 'https://tools.example/r.json', 'https://tools.example/r.json', 'k', 'club tools', 1, 1, 'DL1REG')`,
    );
    expect((await erase(env, p, "DL1REG")).status).toBe(200);
    expect(await one(env, "SELECT added_by FROM tool_registries WHERE id='r1'")).toEqual({ added_by: "WITHDRAWN" });
  });
});

describe("the service call is the instance's, not the sysop's", () => {
  it("leaves out others' service-call traffic from the sysop's export, and keeps the service call's keys and stations", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const sysop = await person(env, "OE8APR");
    const t = nowS();
    const seed: Array<[string, ...unknown[]]> = [
      [
        "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE5XYZ', 'OE8APR-15', 'MAIL DL1AAA hello', 'rx')",
        t,
      ],
      [
        "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE8APR-15', 'OE5XYZ', 'de DL1AAA: hi', 'tx')",
        t,
      ],
      [
        "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE8APR-7', 'OE5XYZ', 'mine', 'tx')",
        t,
      ],
      [
        "INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES ('OE8APR-15', 'svc-key', 'service', 1)",
      ],
      ["INSERT INTO stations (callsign, lat, lon, last_seen) VALUES ('OE8APR-15', 47, 15, ?)", t],
      [
        "INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport) VALUES ('OE8APR-15', ?, 47, 15, 'rf', 'tnc')",
        t,
      ],
    ];
    for (const [sql, ...b] of seed) await exec(env, sql, ...b);
    const exp = await call(env, "POST", "/api/account/OE8APR/export", {}, { cookie: sysop.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.messages.map((m: { body: string }) => m.body)).toEqual(["mine"]);
    expect(exp.data.keys).toEqual([]);
    expect((await erase(env, sysop, "OE8APR")).status).toBe(200);
    expect(await n(env, "SELECT COUNT(*) AS n FROM callsign_keys WHERE callsign='OE8APR-15'")).toBe(1);
    expect(await n(env, "SELECT COUNT(*) AS n FROM stations WHERE callsign='OE8APR-15'")).toBe(1);
    expect(await n(env, "SELECT COUNT(*) AS n FROM positions WHERE callsign='OE8APR-15'")).toBe(1);
  });

  it("the export carries stage unlocks, queued radio traffic, box commands, account events, cache details and weather", async () => {
    const env = authEnv();
    const p = await person(env, "DL1EXP");
    await markCallVerified(env, "DL1EXP");
    const cacheId = await cacheAt(env, "DL1EXP");
    const t = nowS();
    const seed: Array<[string, ...unknown[]]> = [
      [
        "INSERT INTO cache_stages (cache_id, stage_no, lat, lon, clue, unlock) VALUES (?, 1, 47.1, 15.1, 'look up', 'geo')",
        cacheId,
      ],
      [
        "INSERT INTO stage_unlocks (callsign, cache_id, stage_no, unlocked_at) VALUES ('DL1EXP-7', ?, 1, ?)",
        cacheId,
        t,
      ],
      [
        "INSERT INTO aprs_outbox (ts, src_call, kind, payload) VALUES (?, 'DL1EXP-7', 'message', ':OE5XYZ   :hello')",
        t,
      ],
      ["INSERT INTO boxes (box_id, account_id, created_at) VALUES ('box-exp', ?, ?)", p.acct, t],
      [
        "INSERT INTO box_commands (box_id, callsign, kind, payload, created_at) VALUES ('box-exp', 'DL1EXP-10', 'beacon', '{}', ?)",
        t,
      ],
      ["INSERT INTO account_events (callsign, action, detail, at) VALUES ('DL1EXP', 'moved', 'other.example', ?)", t],
      ["INSERT INTO sensor_readings (station, ts, temp_c, source) VALUES ('DL1EXP-13', ?, 21.5, 'rf')", t],
      ["INSERT INTO sensor_readings (station, ts, temp_c, source) VALUES ('OE5XYZ-13', ?, 3, 'rf')", t],
    ];
    for (const [sql, ...b] of seed) await exec(env, sql, ...b);
    const exp = await call(env, "POST", "/api/account/DL1EXP/export", {}, { cookie: p.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.caches[0]).toMatchObject({ code: "AC-ER1", description: "by the oak" });
    expect(exp.data.cacheStages).toEqual([
      expect.objectContaining({ cache_id: cacheId, stage_no: 1, clue: "look up" }),
    ]);
    expect(exp.data.stageUnlocks).toEqual([expect.objectContaining({ callsign: "DL1EXP-7", stage_no: 1 })]);
    expect(exp.data.aprsOutbox).toEqual([
      expect.objectContaining({ src_call: "DL1EXP-7", payload: ":OE5XYZ   :hello" }),
    ]);
    expect(exp.data.boxCommands).toEqual([expect.objectContaining({ box_id: "box-exp", kind: "beacon" })]);
    expect(exp.data.accountEvents).toEqual([expect.objectContaining({ action: "moved", detail: "other.example" })]);
    expect(exp.data.weatherReadings).toEqual([expect.objectContaining({ station: "DL1EXP-13", temp_c: 21.5 })]);
  });
});

describe("a suspension outlives erasure whole", () => {
  it("keeps a longer suspension the call already carries", async () => {
    const env = authEnv();
    const p = await person(env, "DL1LNG");
    const until = nowS() + 3600;
    await call(
      env,
      "POST",
      "/api/admin/moderation/accounts/DL1LNG/suspend",
      { reason: "cool down", category: "spam", until },
      OP,
    );
    await exec(
      env,
      "INSERT INTO callsign_suspensions (callsign, category, until, at) VALUES ('DL1LNG', 'unsafe', NULL, 1)",
    );
    await exec(
      env,
      "INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES ('DL1LNG', 'k', 'phone', 1)",
    );
    const start = await call(env, "POST", "/auth/email/start", {
      email: "dl1lng@example.test",
      purpose: "account-data",
    });
    const open = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect((await call(env, "POST", "/api/account/me/delete", {}, { cookie: open.cookie })).status).toBe(200);
    expect(p.acct).toBeTruthy();
    expect(await one(env, "SELECT category, until FROM callsign_suspensions WHERE callsign='DL1LNG'")).toEqual({
      category: "unsafe",
      until: null,
    });
  });

  it("keeps the audit row saying why while the suspension of an erased account's call lasts", async () => {
    const env = authEnv();
    await person(env, "DL1WHY");
    await call(
      env,
      "POST",
      "/api/admin/moderation/accounts/DL1WHY/suspend",
      { reason: "harassed others", category: "offensive" },
      OP,
    );
    const start = await call(env, "POST", "/auth/email/start", {
      email: "dl1why@example.test",
      purpose: "account-data",
    });
    const open = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect((await call(env, "POST", "/api/account/me/delete", {}, { cookie: open.cookie })).status).toBe(200);
    await exec(env, "UPDATE moderation_log SET at = 1");
    await runScheduled(env);
    expect(await n(env, "SELECT COUNT(*) AS n FROM moderation_log WHERE action='suspend' AND target_id='DL1WHY'")).toBe(
      1,
    );
    // once lifted, the row ages out like any other
    await call(env, "POST", "/api/admin/moderation/accounts/DL1WHY/unsuspend", { reason: "appeal accepted" }, OP);
    await exec(env, "UPDATE moderation_log SET at = 1");
    await runScheduled(env);
    expect(await n(env, "SELECT COUNT(*) AS n FROM moderation_log")).toBe(0);
  });
});

describe("the offline pack sees logs rewritten in place", () => {
  it("changes its generation when a log is anonymised or edited", async () => {
    const env = authEnv();
    const p = await person(env, "DL1PCK");
    const cacheId = await cacheAt(env, "OE8OWN");
    await logOn(env, cacheId, "DL1PCK");
    const first = await packEtag(env);
    expect(await packEtag(env)).toBe(first);
    expect((await erase(env, p, "DL1PCK")).status).toBe(200);
    const second = await packEtag(env);
    expect(second).not.toBe(first);
    await exec(env, "UPDATE cache_logs SET comment='edited' WHERE cache_id=?", cacheId);
    expect(await packEtag(env)).not.toBe(second);
  });
});

/** The offline pack's ETag for the test area. */
async function packEtag(env: Env): Promise<string> {
  const res = await serve(env)(
    new Request("https://gw.test/api/offline/pack?grid=JN77", { headers: { "x-real-ip": nextIp() } }),
  );
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
}

describe("federation keeps deletions and bounds its working tables", () => {
  it("never gives up a missing tombstone, and gives up other records as before", async () => {
    const env = authEnv();
    const old = nowS() - 40 * 86400;
    for (const [kind, reason] of [
      ["tombstone", "unsettled"],
      ["tombstone", "upstream-hops"],
      ["tombstone", "hops"],
      ["find", "unsettled"],
    ])
      await exec(
        env,
        "INSERT INTO fed_origin_gaps (origin, kind, v, reason, first_seen, attempts) VALUES ('peer.test', ?, ?, ?, ?, 9)",
        kind,
        reason === "hops" ? 3 : reason === "upstream-hops" ? 2 : 1,
        reason,
        old,
      );
    await giveUpGaps(env);
    const left = (
      await env.DB.prepare("SELECT kind, reason FROM fed_origin_gaps ORDER BY kind, reason").all<{
        kind: string;
        reason: string;
      }>()
    ).results;
    expect(left).toEqual([
      { kind: "tombstone", reason: "unsettled" },
      { kind: "tombstone", reason: "upstream-hops" },
    ]);
    expect(await n(env, "SELECT COUNT(*) AS n FROM fed_gaps_given_up WHERE kind='find'")).toBe(1);
  });

  it("keeps an unseen given-up record at most 90 days and a seen one 30", async () => {
    const env = authEnv();
    const t = nowS();
    await exec(
      env,
      `INSERT INTO fed_gaps_given_up (origin, kind, v, reason, first_seen, given_up, seen_at) VALUES
         ('peer.test', 'find', 1, 'unsettled', 0, ?, NULL),
         ('peer.test', 'find', 2, 'unsettled', 0, ?, NULL),
         ('peer.test', 'find', 3, 'unsettled', 0, ?, ?)`,
      t - 91 * 86400,
      t - 10 * 86400,
      t - 40 * 86400,
      t - 31 * 86400,
    );
    await giveUpGaps(env);
    expect(
      (await env.DB.prepare("SELECT v FROM fed_gaps_given_up ORDER BY v").all<{ v: number }>()).results.map((r) => r.v),
    ).toEqual([2]);
  });

  it("purges the frames kept for passing on whose record is gone or tombstoned, and keeps tombstone frames", async () => {
    const env = authEnv();
    const t = nowS();
    const frame = (gid: string, kind: string, v = 1) =>
      exec(
        env,
        `INSERT INTO fed_transit (gid, origin, kind, v, frame, signer_key, via, hops, received_at)
         VALUES (?, 'peer.test', ?, ?, X'00', 'k', 'peer.test', 1, ?)`,
        gid,
        kind,
        v,
        t,
      );
    await frame("peer.test:find:1", "find"); // held
    await frame("peer.test:find:2", "find"); // its mirrored row is gone
    await frame("peer.test:find:3", "find"); // tombstoned by its origin
    await frame("peer.test:cache:4", "cache"); // its mirrored row is gone
    await frame("peer.test:tombstone:5", "tombstone");
    await exec(
      env,
      "INSERT INTO remote_finds (global_id, origin, logger_call, mirrored_at) VALUES ('peer.test:find:1', 'peer.test', 'OE5XYZ', ?)",
      t,
    );
    await exec(
      env,
      "INSERT INTO remote_finds (global_id, origin, logger_call, mirrored_at) VALUES ('peer.test:find:3', 'peer.test', 'DL1GON', ?)",
      t,
    );
    await exec(
      env,
      "INSERT INTO remote_tombstones (target_id, origin, kind, ts, mirrored_at) VALUES ('peer.test:find:3', 'peer.test', 'find', ?, ?)",
      t,
      t,
    );
    await runScheduled(env);
    expect(
      (await env.DB.prepare("SELECT gid FROM fed_transit ORDER BY gid").all<{ gid: string }>()).results.map(
        (r) => r.gid,
      ),
    ).toEqual(["peer.test:find:1", "peer.test:tombstone:5"]);
  });
});
