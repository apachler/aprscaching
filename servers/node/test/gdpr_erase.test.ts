// SPDX-License-Identifier: AGPL-3.0-or-later
// GDPR access + erasure cover every account-scoped table: the export carries each one, and after
// erasure nothing personal is left — the passkey cannot sign in, the base call is free to claim
// again, and uploaded cache media is removed from the object store.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, newAuthenticator, passkeyLogin, passkeyRegister } from "./helpers/authflow.js";
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
  ["api_keys", "SELECT COUNT(*) AS n FROM api_keys WHERE owner_call='DL1GDP'"],
  ["auth_challenges", "SELECT COUNT(*) AS n FROM auth_challenges WHERE callsign='DL1GDP'"],
  ["white_pages", "SELECT COUNT(*) AS n FROM white_pages WHERE callsign='DL1GDP'"],
  [
    "bbs_messages",
    "SELECT COUNT(*) AS n FROM bbs_messages WHERE type='P' AND (from_call='DL1GDP' OR to_call='DL1GDP')",
  ],
  ["callsign_challenges", "SELECT COUNT(*) AS n FROM callsign_challenges WHERE account_id=?"],
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
    ["INSERT INTO api_keys (key, owner_call, created_at) VALUES ('k-gdpr', 'DL1GDP', ?)", t],
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
    ])
      expect(exp.data[key], key).toBeTruthy();
    expect(exp.data.passkeys).toHaveLength(1);
    expect(exp.data.passkeys[0]).not.toHaveProperty("public_key");
    expect(exp.data.watchCalls).toHaveLength(1);
    expect(exp.data.apiKeys).toHaveLength(1);
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

    const login = await passkeyLogin(env, CS, auth);
    expect(login.status).not.toBe(200);
    expect(login.cookie).toBe("");

    const again = await emailSignup(env, "new@example.test", CS);
    expect(again.status).toBe(200);
  });
});
