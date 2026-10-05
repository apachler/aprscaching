// SPDX-License-Identifier: AGPL-3.0-or-later
// GDPR access + erasure cover every account-scoped table: the export carries each one, and after
// erasure nothing personal is left — the passkey cannot sign in, the base call is free to claim
// again, and uploaded cache media is removed from the object store.
import { describe, it, expect } from "vitest";
import {
  authEnv,
  call,
  emailSignup,
  markCallVerified,
  newAuthenticator,
  passkeyLogin,
  passkeyRegister,
} from "./helpers/authflow.js";
import { freshDb } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const CS = "DL1GDP";

/** Account-scoped tables and how to count the person's rows in each. */
const SCOPED: Array<[string, string]> = [
  ["credentials", "SELECT COUNT(*) AS n FROM credentials WHERE callsign LIKE 'DL1GDP%'"],
  ["account_callsigns", "SELECT COUNT(*) AS n FROM account_callsigns WHERE account_id=?"],
  ["callsign_history", "SELECT COUNT(*) AS n FROM callsign_history WHERE account_id=?"],
  ["email_tokens", "SELECT COUNT(*) AS n FROM email_tokens WHERE email='gdpr@example.test'"],
  ["watch_calls", "SELECT COUNT(*) AS n FROM watch_calls WHERE account_id=?"],
  ["watch_alerts", "SELECT COUNT(*) AS n FROM watch_alerts WHERE account_id=?"],
  ["saved_views", "SELECT COUNT(*) AS n FROM saved_views WHERE owner_call='DL1GDP'"],
  ["push_subs", "SELECT COUNT(*) AS n FROM push_subs WHERE account_id=?"],
  ["boxes", "SELECT COUNT(*) AS n FROM boxes WHERE account_id=?"],
  ["cache_ratings", "SELECT COUNT(*) AS n FROM cache_ratings WHERE callsign='DL1GDP'"],
  ["cache_media", "SELECT COUNT(*) AS n FROM cache_media WHERE media_key='media/gdpr-1'"],
  ["rendezvous_log", "SELECT COUNT(*) AS n FROM rendezvous_log WHERE call_a='DL1GDP-9' OR call_b='DL1GDP-9'"],
  ["entitlements", "SELECT COUNT(*) AS n FROM entitlements WHERE account_id=?"],
  ["api_keys", "SELECT COUNT(*) AS n FROM api_keys WHERE account_id=?"],
  ["auth_challenges", "SELECT COUNT(*) AS n FROM auth_challenges WHERE callsign='DL1GDP'"],
  ["white_pages", "SELECT COUNT(*) AS n FROM white_pages WHERE callsign='DL1GDP'"],
  [
    "bbs_messages",
    "SELECT COUNT(*) AS n FROM bbs_messages WHERE type='P' AND (from_call='DL1GDP' OR to_call='DL1GDP')",
  ],
  ["bbs bulletins", "SELECT COUNT(*) AS n FROM bbs_messages WHERE type='B' AND from_call='DL1GDP'"],
  [
    "aprs_outbox",
    "SELECT COUNT(*) AS n FROM aprs_outbox WHERE src_call LIKE 'DL1GDP%' OR payload LIKE ':DL1GDP%' OR payload LIKE '%gerd%'",
  ],
  ["message text", "SELECT COUNT(*) AS n FROM messages WHERE body='out'"],
  ["callsign_challenges", "SELECT COUNT(*) AS n FROM callsign_challenges WHERE account_id=?"],
  ["near_cache_messages", "SELECT COUNT(*) AS n FROM near_cache_messages WHERE call='DL1GDP'"],
  ["meshcom_group_messages", "SELECT COUNT(*) AS n FROM meshcom_group_messages WHERE from_call LIKE 'DL1GDP%'"],
  ["positions", "SELECT COUNT(*) AS n FROM positions WHERE callsign LIKE 'DL1GDP%'"],
  ["stations", "SELECT COUNT(*) AS n FROM stations WHERE callsign LIKE 'DL1GDP%'"],
  ["messages", "SELECT COUNT(*) AS n FROM messages WHERE from_call LIKE 'DL1GDP%' OR to_call LIKE 'DL1GDP%'"],
  ["cache_stages", "SELECT COUNT(*) AS n FROM cache_stages WHERE media_key IS NOT NULL"],
  ["accounts", "SELECT COUNT(*) AS n FROM accounts WHERE account_id=?"],
];

async function seeded() {
  const deleted: string[] = [];
  const media = {
    put: async () => {},
    get: async () => null,
    delete: async (k: string) => void deleted.push(k),
  };
  const env = authEnv({ MEDIA: media }, freshDb().DB);
  const auth = await newAuthenticator();
  const reg = await passkeyRegister(env, CS, auth);
  expect(reg.status).toBe(200);
  await markCallVerified(env, CS);
  await env.DB.prepare("UPDATE accounts SET email='gdpr@example.test' WHERE callsign=?").bind(CS).run();
  // a login link leaves an email token behind
  expect((await call(env, "POST", "/auth/email/start", { email: "gdpr@example.test" })).status).toBe(200);
  const acct = (await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign=?")
    .bind(CS)
    .first<{ account_id: string }>())!.account_id;
  const created = await call(
    env,
    "POST",
    "/api/caches",
    { title: "gdpr cache", type: "traditional", lat: 47, lon: 15 },
    { cookie: reg.cookie },
  );
  expect(created.status).toBe(201);
  const cacheId = created.data.cache.id as number;
  const t = 1_700_000_000;
  const seed = [
    ["INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, 'DL1GDP', ?, 0)", acct, t],
    ["INSERT INTO watch_calls (account_id, callsign, added_at) VALUES (?, 'OE8APR', ?)", acct, t],
    ["INSERT INTO watch_alerts (account_id, callsign, kind, ts) VALUES (?, 'OE8APR', 'heard', ?)", acct, t],
    [
      "INSERT INTO saved_views (slug, owner_call, name, state, created_at) VALUES ('v-gdpr', 'DL1GDP', 'home', '{}', ?)",
      t,
    ],
    ["INSERT INTO push_subs (account_id, endpoint, created_at) VALUES (?, 'https://push.example/x', ?)", acct, t],
    ["INSERT INTO boxes (box_id, account_id, created_at) VALUES ('box-gdpr', ?, ?)", acct, t],
    ["INSERT INTO cache_ratings (cache_id, callsign, stars, ts) VALUES (1, 'DL1GDP', 4, ?)", t],
    [
      "INSERT INTO cache_media (cache_id, media_key, kind, content_type, bytes, created_at) VALUES (?, 'media/gdpr-1', 'image', 'image/png', 3, ?)",
      cacheId,
      t,
    ],
    ["INSERT INTO rendezvous_log (cache_a, cache_b, call_a, call_b, ts) VALUES (1, 2, 'DL1GDP-9', 'OE8APR-9', ?)", t],
    ["INSERT INTO entitlements (account_id, key, granted_at) VALUES (?, 'supporter_badge', ?)", acct, t],
    [
      "INSERT INTO api_keys (key_hash, prefix, account_id, name, created_at) VALUES ('h-gdpr', 'acg_12345678', ?, 'logger', ?)",
      acct,
      t,
    ],
    [
      "INSERT INTO auth_challenges (id, callsign, kind, value, expires_at) VALUES ('c-gdpr', 'DL1GDP', 'webauthn_login', 'x', ?)",
      t * 2,
    ],
    ["INSERT INTO white_pages (callsign, home_bbs, updated_at) VALUES ('DL1GDP', 'OE8XBM', ?)", t],
    [
      "INSERT INTO callsign_challenges (callsign, method, account_id, challenge, created_at) VALUES ('DL1GDP', 'lotw', ?, 'n', ?)",
      acct,
      t,
    ],
    [
      "INSERT INTO bbs_messages (type, from_call, to_call, body, posted_at) VALUES ('P', 'OE8APR', 'DL1GDP', 'hi', ?)",
      t,
    ],
    [
      "INSERT INTO near_cache_messages (call, cache_id, station, msg_no, sent_at) VALUES ('DL1GDP', ?, 'DL1GDP-7', 'N0001', ?)",
      cacheId,
      t,
    ],
    [
      "INSERT INTO meshcom_group_messages (ts, from_call, grp, body, dedup_key) VALUES (?, 'DL1GDP-12', '232', 'hi', 'id:DL1GDP-12:1')",
      t,
    ],
    [
      "INSERT INTO meshcom_group_messages (ts, from_call, grp, body, dedup_key) VALUES (?, 'OE8APR-12', '232', 'hi', 'id:OE8APR-12:1')",
      t,
    ],
    ["UPDATE accounts SET near_radio = 1 WHERE account_id = ?", acct],
    ["UPDATE accounts SET display_name = 'Gerd', home_grid = 'JN77' WHERE account_id = ?", acct],
    // a tracker on an SSID, and the map's latest state for it
    [
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport) VALUES ('DL1GDP-9', ?, 47, 15, 'rf', 'tnc')",
      t,
    ],
    ["INSERT INTO stations (callsign, lat, lon, last_seen) VALUES ('DL1GDP-9', 47, 15, ?)", t],
    // APRS messages the person sent from an SSID and was sent, and one between two other stations
    ["INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'DL1GDP-7', 'OE8APR', 'out', 'tx')", t],
    ["INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE8APR', 'DL1GDP', 'in', 'rx')", t],
    ["INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'OE8APR', 'OE5XYZ', 'other', 'rx')", t],
    // a bulletin the person posted and another station's reply to it
    [
      "INSERT INTO bbs_messages (id, type, from_call, to_call, subject, body, posted_at) VALUES (900, 'B', 'DL1GDP', 'ALL', 'qrv', 'gerd here', ?)",
      t,
    ],
    [
      "INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, reply_to, thread_id) VALUES ('B', 'OE8APR', 'ALL', 'Re: qrv', 'welcome', ?, 900, 900)",
      t,
    ],
    // radio messages queued for the person and addressed to the person
    [
      "INSERT INTO aprs_outbox (ts, src_call, kind, payload) VALUES (?, 'DL1GDP-7', 'message', ':OE8APR   :from gerd')",
      t,
    ],
    ["INSERT INTO aprs_outbox (ts, src_call, kind, payload) VALUES (?, 'OE8APR-15', 'message', ':DL1GDP-7 :mail')", t],
    ["INSERT INTO aprs_outbox (ts, src_call, kind, payload) VALUES (?, 'OE8APR-15', 'message', ':OE5XYZ   :mail')", t],
    // an audio clue on a stage of the person's cache
    [
      "INSERT INTO cache_stages (cache_id, stage_no, unlock, media_key, media_bytes) VALUES (?, 1, 'audio', 'cache/1/stage/1/clue-00000000000a.mpeg', 3)",
      cacheId,
    ],
  ] as const;
  for (const [sql, ...binds] of seed)
    await env.DB.prepare(sql)
      .bind(...binds)
      .run();
  return { env, auth, cookie: reg.cookie, acct, deleted };
}

async function counts(env: Env, acct: string) {
  const out: Record<string, number> = {};
  for (const [table, sql] of SCOPED) {
    const stmt = env.DB.prepare(sql);
    const r = await (sql.includes("?") ? stmt.bind(acct) : stmt).first<{ n: number }>();
    out[table] = r?.n ?? 0;
  }
  return out;
}

describe("GDPR export and erasure cover every account-scoped table", () => {
  it("the export carries the person's rows from each account-scoped table", async () => {
    const { env, cookie } = await seeded();
    const exp = await call(env, "POST", `/api/account/${CS}/export`, {}, { cookie });
    expect(exp.status).toBe(200);
    for (const key of [
      "passkeys",
      "callsigns",
      "callsignHistory",
      "watchCalls",
      "watchAlerts",
      "savedViews",
      "pushSubscriptions",
      "boxes",
      "ratings",
      "cacheMedia",
      "rendezvous",
      "entitlements",
      "apiKeys",
      "bbsMessages",
      "verificationChallenges",
      "nearCacheMessages",
      "meshcomGroupMessages",
    ])
      expect(exp.data[key], key).toBeTruthy();
    expect(exp.data.nearCacheMessages).toHaveLength(1);
    // the person's own group messages, from any SSID, and nobody else's
    expect(exp.data.meshcomGroupMessages).toEqual([expect.objectContaining({ from_call: "DL1GDP-12", grp: "232" })]);
    expect(exp.data.account.near_radio).toBe(1);
    expect(exp.data.passkeys).toHaveLength(1);
    expect(exp.data.passkeys[0]).not.toHaveProperty("public_key");
    expect(exp.data.watchCalls).toHaveLength(1);
    expect(exp.data.apiKeys).toHaveLength(1);
    expect(exp.data.account).toMatchObject({ email: "gdpr@example.test", display_name: "Gerd", home_grid: "JN77" });
    expect(exp.data.positions).toEqual([expect.objectContaining({ callsign: "DL1GDP-9" })]);
    expect(exp.data.messages.map((m: { body: string }) => m.body).sort()).toEqual(["in", "out"]);
  });

  it("the export by a held call that is not the active one finds the account", async () => {
    const { env, cookie, acct } = await seeded();
    await env.DB.prepare("INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES (?, 'DL2GDP', 1)")
      .bind(acct)
      .run();
    const exp = await call(env, "POST", "/api/account/DL2GDP/export", {}, { cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.account).toMatchObject({ callsign: CS, email: "gdpr@example.test" });
    expect(exp.data.callsigns.map((c: { callsign: string }) => c.callsign).sort()).toEqual(["DL1GDP", "DL2GDP"]);
    expect(exp.data.positions).toHaveLength(1);
  });

  it("erasure leaves no personal row, removes media, disables the passkey and frees the call", async () => {
    const { env, cookie, acct, auth, deleted } = await seeded();
    const before = await counts(env, acct);
    for (const [table, n] of Object.entries(before)) expect(n, `seeded ${table}`).toBeGreaterThan(0);

    const del = await call(env, "POST", `/api/account/${CS}/delete`, {}, { cookie });
    expect(del.status).toBe(200);

    const after = await counts(env, acct);
    for (const [table, n] of Object.entries(after)) expect(n, `left in ${table}`).toBe(0);
    expect(deleted).toContain("media/gdpr-1");
    expect(deleted).toContain("cache/1/stage/1/clue-00000000000a.mpeg");
    // The person's message text is gone but its place in the conversation stays, withdrawn; the message the
    // other station sent them stays, and so does the one between two other stations.
    const msgs = (await call(env, "GET", "/api/messages")).data.messages as Array<{ fromCall: string; body: string }>;
    expect(msgs.map((m) => [m.fromCall, m.body]).sort()).toEqual([
      ["OE8APR", "in"],
      ["OE8APR", "other"],
      ["WITHDRAWN", ""],
    ]);
    // the reply another station posted to the person's bulletin stays; other outbound traffic stays
    const bulletins = (await env.DB.prepare("SELECT body FROM bbs_messages WHERE type='B'").all<{ body: string }>())
      .results;
    expect(bulletins.map((b) => b.body)).toEqual(["welcome"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM aprs_outbox").first<{ n: number }>())?.n).toBe(1);
    // another station's group message stays
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM meshcom_group_messages").first<{ n: number }>())?.n).toBe(
      1,
    );

    const login = await passkeyLogin(env, CS, auth);
    expect(login.status).not.toBe(200);
    expect(login.cookie).toBe("");

    const again = await emailSignup(env, "new@example.test", CS);
    expect(again.status).toBe(200);
  });

  it("a sysop's erasure leaves the service call's traffic, which is the instance's", async () => {
    const { env, cookie } = await seeded();
    (env as Env & { ADMIN_CALLSIGNS: string }).ADMIN_CALLSIGNS = CS;
    const t = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages (ts, from_call, to_call, body, direction) VALUES (?, 'DL1GDP-15', 'OE8APR', 'logged', 'tx')",
      ).bind(t),
      env.DB.prepare(
        "INSERT INTO aprs_outbox (ts, src_call, kind, payload) VALUES (?, 'DL1GDP-15', 'message', ':OE8APR   :logged')",
      ).bind(t),
    ]);
    expect((await call(env, "POST", `/api/account/${CS}/delete`, {}, { cookie })).status).toBe(200);
    expect(await env.DB.prepare("SELECT from_call, body FROM messages WHERE from_call='DL1GDP-15'").first()).toEqual({
      from_call: "DL1GDP-15",
      body: "logged",
    });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM aprs_outbox WHERE src_call='DL1GDP-15'").first<{ n: number }>())
        ?.n,
    ).toBe(1);
  });
});
