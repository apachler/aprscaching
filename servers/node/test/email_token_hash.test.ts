// SPDX-License-Identifier: AGPL-3.0-or-later
// A sign-in link's token lives only in the link: `email_tokens` holds its SHA-256, so a copy of the database (a
// backup, a leaked file) carries no link anyone can spend. Every flow that mints a link still signs in with it.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, tokenKey } from "./helpers/authflow.js";

const OP = { "x-operator-secret": "test-operator-secret" };

/** Every column of every `email_tokens` row, as text. */
async function storedValues(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT * FROM email_tokens").all<Record<string, unknown>>();
  return results.flatMap((r) => Object.values(r).map((v) => String(v)));
}

/** The row a link wrote holds no column equal to its token, its key is the token's hash, and the link signs in. */
async function holdsOnlyTheHash(env: Env, token: string, cookie = ""): Promise<void> {
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const values = await storedValues(env);
  expect(values).not.toContain(token);
  expect(values.some((v) => v.includes(token))).toBe(false);
  const row = await env.DB.prepare("SELECT used FROM email_tokens WHERE token = ?")
    .bind(await tokenKey(token))
    .first<{ used: number }>();
  expect(row?.used).toBe(0);
  const signedIn = await call(env, "POST", "/auth/email/verify", { token }, cookie ? { cookie } : {});
  expect(signedIn.status).toBe(200);
  expect(signedIn.cookie).toMatch(/^acs=/);
  // spent by its hash: the same link does not sign in twice
  expect((await call(env, "POST", "/auth/email/verify", { token })).status).toBe(400);
}

describe("email_tokens stores only the hash of a sign-in token", () => {
  it("register", async () => {
    const env = authEnv();
    const start = await call(env, "POST", "/auth/email/start", { email: "reg@example.test", callsign: "DL1REG" });
    expect(start.status).toBe(200);
    await holdsOnlyTheHash(env, start.data.devToken);
  });

  it("login", async () => {
    const env = authEnv();
    expect((await emailSignup(env, "login@example.test", "DL1LOG")).status).toBe(200);
    await env.DB.prepare("DELETE FROM email_tokens").run();
    const start = await call(env, "POST", "/auth/email/start", { email: "login@example.test" });
    expect(start.status).toBe(200);
    await holdsOnlyTheHash(env, start.data.devToken);
  });

  it("recovery address confirmation", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "first@example.test", "DL1REC");
    expect(s.status).toBe(200);
    await env.DB.prepare("DELETE FROM email_tokens").run();
    const change = await call(
      env,
      "POST",
      "/auth/email/change",
      { email: "second@example.test" },
      { cookie: s.cookie },
    );
    expect(change.status).toBe(200);
    await holdsOnlyTheHash(env, change.data.devToken);
    const acct = await env.DB.prepare("SELECT email FROM accounts WHERE callsign = 'DL1REC'").first<{
      email: string;
    }>();
    expect(acct?.email).toBe("second@example.test");
  });

  it("the operator's sign-in link", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const mint = await call(env, "POST", "/auth/operator-link", { callsign: "OE8APR" }, OP);
    expect(mint.status).toBe(200);
    await holdsOnlyTheHash(env, new URL(mint.data.link).searchParams.get("token")!);
  });

  it("a row written before the update (the raw token as its key) no longer signs in", async () => {
    const env = authEnv();
    const raw = "a".repeat(64);
    await env.DB.prepare(
      "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, 'old@example.test', 'DL1OLD', 'register', ?, 0)",
    )
      .bind(raw, Math.floor(Date.now() / 1000))
      .run();
    expect((await call(env, "POST", "/auth/email/verify", { token: raw })).status).toBe(400);
    // the same address asks again and signs in
    const start = await call(env, "POST", "/auth/email/start", { email: "old@example.test", callsign: "DL1OLD" });
    expect(start.status).toBe(200);
    expect((await call(env, "POST", "/auth/email/verify", { token: start.data.devToken })).status).toBe(200);
  });
});
