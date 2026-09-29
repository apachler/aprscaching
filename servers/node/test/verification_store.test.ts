// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification has one store: `callsign_verifications`, keyed by base call. Every
// surface that reports or gates on it — the session, the held-call list, device keys, the key feed, the
// sysop role — reads that store, so a verification or a revocation shows everywhere at once and no
// other table can disagree with it.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { migrate } from "../src/migrate.js";
import type { Env } from "@aprscaching/gateway/env";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

async function sysopWorld(): Promise<{ env: Env; sysop: Res }> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR");
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

const session = async (env: Env, cookie: string) =>
  (await call(env, "GET", "/auth/session", undefined, { cookie })).data;
const heldCalls = async (env: Env, cookie: string) =>
  (await call(env, "GET", "/auth/callsigns", undefined, { cookie })).data.callsigns as {
    callsign: string;
    verified: boolean;
  }[];

describe("verification is read from callsign_verifications everywhere", () => {
  it("a verification that lands after sign-up shows on the session, the held calls and existing keys", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR");
    const key = newKey();
    const reg = await call(
      env,
      "POST",
      "/keys/register",
      { callsign: "OE8APR-7", publicKey: key },
      { cookie: s.cookie },
    );
    expect(reg.status).toBe(200);
    expect(reg.data.verified).toBe(false);
    expect((await session(env, s.cookie)).verified).toBe(false);

    await operatorVerify(env, "OE8APR");

    expect((await session(env, s.cookie)).verified).toBe(true);
    expect(await heldCalls(env, s.cookie)).toEqual([expect.objectContaining({ callsign: "OE8APR", verified: true })]);
    // a key registered before the call was verified carries the call's current state; an SSID inherits it
    const keys = await call(env, "GET", "/keys/OE8APR-7");
    expect(keys.data.keys).toEqual([expect.objectContaining({ publicKey: key, verified: true })]);
    const feed = await call(env, "GET", "/federation/keys");
    expect(feed.status).toBe(200);
  });

  it("an SSID session reports its base call's verification", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR-9");
    expect(s.status).toBe(200);
    expect((await session(env, s.cookie)).verified).toBe(false);
    await operatorVerify(env, "OE8APR");
    expect((await session(env, s.cookie)).verified).toBe(true);
  });

  it("switching between held calls keeps each call's own verification", async () => {
    const { env, sysop } = await sysopWorld();
    const sw = await call(env, "POST", "/auth/callsign", { callsign: "OE9NEW" }, { cookie: sysop.cookie });
    expect(sw.status).toBe(200);
    expect(sw.data.verified).toBe(false);
    expect((await session(env, sw.cookie)).verified).toBe(false);
    const back = await call(env, "POST", "/auth/callsign", { callsign: "OE8APR" }, { cookie: sw.cookie });
    expect(back.data.verified).toBe(true);
    expect((await session(env, back.cookie)).verified).toBe(true);
    const list = await heldCalls(env, back.cookie);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callsign: "OE8APR", verified: true }),
        expect.objectContaining({ callsign: "OE9NEW", verified: false }),
      ]),
    );
  });

  it("a sysop revocation clears the verification on every surface at once", async () => {
    const { env, sysop } = await sysopWorld();
    const u = await emailSignup(env, "dl1abc@example.test", "DL1ABC");
    const key = newKey();
    await call(env, "POST", "/keys/register", { callsign: "DL1ABC", publicKey: key }, { cookie: u.cookie });
    const v = await call(
      env,
      "POST",
      "/api/admin/verifications",
      { callsign: "DL1ABC", note: "licence checked" },
      { cookie: sysop.cookie },
    );
    expect(v.status).toBe(201);
    expect((await session(env, u.cookie)).verified).toBe(true);
    expect((await call(env, "GET", "/keys/DL1ABC")).data.keys[0].verified).toBe(true);

    const r = await call(env, "DELETE", "/api/admin/verifications/DL1ABC", undefined, { cookie: sysop.cookie });
    expect(r.status).toBe(200);
    expect((await session(env, u.cookie)).verified).toBe(false);
    expect(await heldCalls(env, u.cookie)).toEqual([expect.objectContaining({ callsign: "DL1ABC", verified: false })]);
    expect((await call(env, "GET", "/keys/DL1ABC")).data.keys[0].verified).toBe(false);
  });

  it("the sysop role follows the verification store alone", async () => {
    const { env, sysop } = await sysopWorld();
    expect((await call(env, "GET", "/api/admin/whoami", undefined, { cookie: sysop.cookie })).data.sysop).toBe(true);
    await env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign='OE8APR'").run();
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: sysop.cookie });
    expect(who.data.sysop).toBe(false);
    expect(who.data.pending).toBe("verify");
  });

  it("a call verified while nobody held it reaches no one who claims it later", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    await operatorVerify(env, "OE8APR");
    expect((await call(env, "GET", "/verify/aprs/status?callsign=OE8APR")).data.verified).toBe(true);
    const s = await emailSignup(env, "first@example.test", "OE8APR");
    expect(s.status).toBe(200);
    expect((await session(env, s.cookie)).verified).toBe(false);
    expect((await call(env, "GET", "/verify/aprs/status?callsign=OE8APR")).data.verified).toBe(false);
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: s.cookie });
    expect(who.data).toMatchObject({ sysop: false, pending: "verify" });
    // verified for its holder, it holds
    await operatorVerify(env, "OE8APR");
    expect((await call(env, "GET", "/api/admin/whoami", undefined, { cookie: s.cookie })).data.sysop).toBe(true);
  });

  it("the GDPR export reports verification from the store", async () => {
    const { env, sysop } = await sysopWorld();
    const ex = await call(env, "POST", "/api/account/OE8APR/export", {}, { cookie: sysop.cookie });
    expect(ex.status).toBe(200);
    expect(ex.data.verifications).toEqual([expect.objectContaining({ method: "operator", status: "verified" })]);
    expect(ex.data.account).toMatchObject({ callsign: "OE8APR", verified: 1, verify_method: "operator" });
    expect(ex.data.account.verified_at).toEqual(expect.any(Number));
    expect(ex.data.callsigns).toEqual([
      expect.objectContaining({ callsign: "OE8APR", verified: 1, method: "operator", is_primary: 1 }),
    ]);
    // a device key's export row keeps its verified flag, derived from the store
    await call(env, "POST", "/keys/register", { callsign: "OE8APR", publicKey: newKey() }, { cookie: sysop.cookie });
    const ex2 = await call(env, "POST", "/api/account/OE8APR/export", {}, { cookie: sysop.cookie });
    expect(ex2.data.keys).toEqual([expect.objectContaining({ verified: 1 })]);
  });

  it("no other table carries a verification column", async () => {
    const env = authEnv();
    const cols = async (t: string) =>
      (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map(
        (r) => r.name,
      );
    expect(await cols("accounts")).not.toEqual(expect.arrayContaining(["verified"]));
    for (const c of ["verified", "verify_method", "verified_at"]) expect(await cols("accounts")).not.toContain(c);
    for (const c of ["verified", "method", "verified_at"]) expect(await cols("account_callsigns")).not.toContain(c);
    expect(await cols("callsign_keys")).not.toContain("verified");
  });
});

describe("one holder per base call", () => {
  it("the schema refuses a second account holding the same base call", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS);
    db.prepare(
      "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('a', 'OE8BAS', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('x', 'OE8BAS', 0, 9)",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
