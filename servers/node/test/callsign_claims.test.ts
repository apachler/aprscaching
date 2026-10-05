// SPDX-License-Identifier: AGPL-3.0-or-later
// A held call is not its holder's for good while the holder has not proven control of it: the licensee opens a
// claim and completes any control-verification method with the claim's token, and the call moves to them,
// verified. A verified holder is displaced only by the sysop, and an ADMIN_CALLSIGNS call is registered only
// through the operator's link or a proof of control. What the previous holder wrote stays on their account.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@aprscaching/gateway/env";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { serviceCall } from "@aprscaching/gateway/servicecall";
import { newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";
import {
  authEnv,
  call,
  emailSignup,
  hiderSignup,
  newAuthenticator,
  operatorSignup,
  operatorVerify,
  passkeyRegister,
  type Res,
} from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000);

// ---- the LoTW proof (synthetic certificates, workers/gateway/test/fixtures/lotw/gen.sh)
const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../workers/gateway/test/fixtures/lotw");
const pem = (f: string) => readFileSync(path.join(FX, f), "utf8");
const b64 = (p: string) => p.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
const chain = () => [b64(pem("user-oe8apr.pem")), b64(pem("ca.pem")), b64(pem("root.pem"))];
async function sign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    readFileSync(path.join(FX, "user.key.der")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(message))).toString(
    "base64",
  );
}

// ---- the ampr.org proof: one validating resolver answers with DNSSEC
const DOH = "https://dns.example/dns-query";
const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});
function stubAmpr(value: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const name = new URL(String(input)).searchParams.get("name")!;
    return new Response(JSON.stringify({ Status: 0, AD: true, Answer: [{ name, type: 16, data: `"${value}"` }] }), {
      headers: { "content-type": "application/dns-json" },
    });
  }) as typeof fetch;
}

const claimEnv = (extra: Record<string, unknown> = {}) =>
  authEnv({ FIRST_PARTY_SITES: "OE8XXX", LOTW_CA_PEM: pem("root.pem"), DOH_URL: DOH, ...extra });

const session = async (env: Env, cookie: string) =>
  (await call(env, "GET", "/auth/session", undefined, { cookie })).data;
const holderOf = async (env: Env, cs: string) =>
  (
    await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ?")
      .bind(cs)
      .first<{ account_id: string }>()
  )?.account_id ?? null;
const accountOf = async (env: Env, cookie: string) =>
  (await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign = ?")
    .bind((await session(env, cookie)).callsign)
    .first<{
      account_id: string;
    }>())!.account_id;

/** Open a claim on `cs`, signed in (`cookie`) or not. */
async function openClaim(env: Env, cs: string, cookie?: string): Promise<Res> {
  return call(env, "POST", "/auth/claims", { callsign: cs }, cookie ? { cookie } : {});
}

/** Complete a claim by an on-air `VERIFY` heard at the attested site OE8XXX. */
async function proveOnAir(env: Env, cs: string, claim: string) {
  const s = await call(env, "POST", "/verify/aprs/start", { callsign: cs, claim });
  expect(s.status, JSON.stringify(s.data)).toBe(200);
  await call(
    env,
    "POST",
    "/ingest",
    {
      packets: [
        {
          src: `${cs}-7`,
          dst: "APRS",
          path: ["WIDE1-1", "qAR", "OE8XXX"],
          payload: `:${String(s.data.to).padEnd(9)}:${s.data.text}`,
          kind: "message",
          heardVia: "rf",
          igateCall: "OE8XXX",
          port: "kiss-tnc",
          ts: now(),
        },
      ],
    },
    INGEST,
  );
}

/** Complete a claim on OE8APR with its (synthetic) LoTW certificate. */
async function proveLotw(env: Env, claim: string) {
  const s = await call(env, "POST", "/verify/lotw/start", { callsign: "OE8APR", claim });
  expect(s.status, JSON.stringify(s.data)).toBe(200);
  return call(env, "POST", "/verify/lotw/complete", {
    callsign: "OE8APR",
    claim,
    certificates: chain(),
    signature: await sign(s.data.message),
  });
}

/** Complete a claim through a DNSSEC-validated ampr.org record. */
async function proveAmpr(env: Env, cs: string, claim: string) {
  const s = await call(env, "POST", "/verify/ampr/start", { callsign: cs, claim });
  expect(s.status, JSON.stringify(s.data)).toBe(200);
  stubAmpr(s.data.value);
  return call(env, "POST", "/verify/ampr/check", { callsign: cs, claim });
}

const status = (env: Env, claim: string) => call(env, "POST", "/auth/claims/status", { claim });

describe("the sign-in probe and sign-up", () => {
  it("say that an unproven holder's call can be taken over, instead of only 'sign in'", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const probe = await call(env, "POST", "/auth/claim", { callsign: "OE8APR" });
    expect(probe.data).toMatchObject({ exists: true, claimable: true, operatorCall: false });
    const signup = await call(env, "POST", "/auth/email/start", { email: "real@example.test", callsign: "OE8APR" });
    expect(signup.status).toBe(409);
    expect(signup.data.reason).toBe("held_unverified");
    const passkey = await passkeyRegister(env, "OE8APR", await newAuthenticator());
    expect(passkey.data.reason).toBe("held_unverified");
  });
});

describe("a claim by proof of control", () => {
  it.each([
    ["on the air", "rf"],
    ["through ampr.org DNS", "ampr"],
    ["with a LoTW certificate", "lotw"],
  ])("moves an unproven holder's call to a new account %s", async (_label, method) => {
    const env = claimEnv();
    const squat = await emailSignup(env, "squat@example.test", "OE8APR");
    const squatAcct = await accountOf(env, squat.cookie);

    const opened = await openClaim(env, "OE8APR");
    expect(opened.status).toBe(201);
    const token = opened.data.claim as string;
    expect((await status(env, token)).data.status).toBe("open");

    if (method === "rf") await proveOnAir(env, "OE8APR", token);
    if (method === "ampr") expect((await proveAmpr(env, "OE8APR", token)).data).toMatchObject({ claimed: true });
    if (method === "lotw") expect((await proveLotw(env, token)).data).toMatchObject({ claimed: true });

    const done = await status(env, token);
    expect(done.data).toMatchObject({ status: "done", callsign: "OE8APR", signedIn: true });
    expect(done.cookie).not.toBe("");
    expect(await session(env, done.cookie)).toMatchObject({ callsign: "OE8APR", verified: true });
    // the token opens one session only
    expect((await status(env, token)).cookie).toBe("");
    // the call is on a new account; the previous holder's sessions on it end, and their account stays
    expect(await holderOf(env, "OE8APR")).not.toBe(squatAcct);
    expect((await session(env, squat.cookie)).callsign).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE account_id = ?").bind(squatAcct).first(),
    ).not.toBeNull();
    const ev = await env.DB.prepare(
      "SELECT action, from_account, actor FROM callsign_events WHERE callsign='OE8APR'",
    ).all();
    expect(ev.results).toEqual([
      { action: "claimed", from_account: squatAcct, actor: { rf: "rf_heard", ampr: "ampr_dns", lotw: "lotw" }[method] },
    ]);
  });

  it("adds the call, verified, to a signed-in claimant's account and keeps their active call", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const lic = await emailSignup(env, "lic@example.test", "DL2LIC");
    const opened = await openClaim(env, "OE8APR", lic.cookie);
    await proveOnAir(env, "OE8APR", opened.data.claim);
    expect((await status(env, opened.data.claim)).data).toMatchObject({ status: "done" });
    expect(await holderOf(env, "OE8APR")).toBe(await accountOf(env, lic.cookie));
    const held = (await call(env, "GET", "/auth/callsigns", undefined, { cookie: lic.cookie })).data;
    expect(held.active).toBe("DL2LIC");
    expect(held.callsigns).toEqual(
      expect.arrayContaining([expect.objectContaining({ callsign: "OE8APR", verified: true, isPrimary: false })]),
    );
  });

  it("never displaces a holder that has proven control", async () => {
    const env = claimEnv();
    const holder = await emailSignup(env, "holder@example.test", "OE8APR");
    const s = await call(env, "POST", "/verify/lotw/start", { callsign: "OE8APR" }, { cookie: holder.cookie });
    await call(
      env,
      "POST",
      "/verify/lotw/complete",
      { callsign: "OE8APR", certificates: chain(), signature: await sign(s.data.message) },
      { cookie: holder.cookie },
    );
    expect((await session(env, holder.cookie)).verified).toBe(true);
    const r = await openClaim(env, "OE8APR");
    expect(r.status).toBe(409);
    expect(r.data.reason).toBe("held_verified");
    expect((await call(env, "POST", "/auth/claim", { callsign: "OE8APR" })).data.claimable).toBe(false);
  });

  it("refuses a proof that lands after the holder proved control themselves", async () => {
    const env = claimEnv();
    const holder = await emailSignup(env, "holder@example.test", "OE8APR");
    const opened = await openClaim(env, "OE8APR");
    // the holder proves control first
    const s = await call(env, "POST", "/verify/lotw/start", { callsign: "OE8APR" }, { cookie: holder.cookie });
    await call(
      env,
      "POST",
      "/verify/lotw/complete",
      { callsign: "OE8APR", certificates: chain(), signature: await sign(s.data.message) },
      { cookie: holder.cookie },
    );
    const late = await proveLotw(env, opened.data.claim);
    expect(late.status).toBe(409);
    expect((await status(env, opened.data.claim)).data.status).toBe("refused");
    expect(await holderOf(env, "OE8APR")).toBe(await accountOf(env, holder.cookie));
  });

  it("needs an open claim's token on the call it names, and no claim on a call nobody holds", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    expect((await call(env, "POST", "/verify/lotw/start", { callsign: "OE8APR", claim: "x".repeat(32) })).status).toBe(
      409,
    );
    const opened = await openClaim(env, "OE8APR");
    expect(
      (await call(env, "POST", "/verify/ampr/start", { callsign: "DL1AAA", claim: opened.data.claim })).status,
    ).toBe(409);
    expect((await openClaim(env, "DL9NEW")).data.reason).toBe("unheld");
  });
});

describe("the previous holder's content", () => {
  async function squatted(env: Env, opts: { otherCall?: string } = {}) {
    const squat = await emailSignup(env, "squat@example.test", opts.otherCall ?? "OE8APR");
    let cookie = squat.cookie;
    if (opts.otherCall) {
      await call(env, "POST", "/auth/callsigns", { callsign: "OE8APR" }, { cookie });
      cookie = (await call(env, "POST", "/auth/callsign", { callsign: "OE8APR" }, { cookie })).cookie;
    }
    const finder = await hiderSignup(env, "owner@example.test", "DL1OWN");
    const theirs = await call(
      env,
      "POST",
      "/api/caches",
      { title: "oak", type: "traditional", lat: 47, lon: 15 },
      {
        cookie: finder.cookie,
      },
    );
    const mine = await call(
      env,
      "POST",
      "/api/caches",
      { title: "elm", type: "traditional", lat: 46, lon: 14, ownerCall: "OE8APR" },
      // an unverified holder hides nothing from the web; the cache came in over the air, owned by the call
      INGEST,
    );
    expect(mine.status).toBe(201);
    const log = await call(
      env,
      "POST",
      `/api/caches/${theirs.data.cache.id}/logs`,
      { logType: "note", comment: "hi" },
      {
        cookie,
      },
    );
    expect(log.status, JSON.stringify(log.data)).toBe(200);
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    expect(
      (await call(env, "POST", "/keys/register", { callsign: "OE8APR-7", publicKey: key }, { cookie })).status,
    ).toBe(200);
    return { squatAcct: await accountOf(env, cookie), cacheId: mine.data.cache.id as number, cookie };
  }

  it("stays on their account under FORMER when they hold no other call, and follows them to a new call", async () => {
    const env = claimEnv({ INSTANCE: "gw.test" });
    const { squatAcct, cacheId, cookie: squatCookie } = await squatted(env);
    const opened = await openClaim(env, "OE8APR");
    await proveLotw(env, opened.data.claim);
    const lic = await status(env, opened.data.claim);
    // the previous holder's browser learns why its session ended, and that the account holds no call now
    expect((await session(env, squatCookie)).ended).toEqual({
      reason: "released",
      callsign: "OE8APR",
      by: "licensee",
      note: null,
      callless: true,
    });

    const owner = await env.DB.prepare("SELECT owner_call FROM caches WHERE id = ?")
      .bind(cacheId)
      .first<{ owner_call: string }>();
    expect(owner!.owner_call).toMatch(/^FORMER#/);
    const acct = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id = ?")
      .bind(squatAcct)
      .first<{ callsign: string }>();
    expect(acct!.callsign).toBe(owner!.owner_call);
    const logs = await env.DB.prepare("SELECT logger_call FROM cache_logs").all<{ logger_call: string }>();
    expect(logs.results.map((l) => l.logger_call)).toEqual([owner!.owner_call]);
    // readers see the marker without its suffix, and the licensee does not own the cache
    expect((await call(env, "GET", `/api/caches/${cacheId}`)).data.cache.ownerCall).toBe("FORMER");
    const edit = await call(
      env,
      "POST",
      `/api/caches/${cacheId}/stages`,
      { stages: [{ stageNo: 0, unlock: "open", lat: 46, lon: 14 }] },
      { cookie: lic.cookie },
    );
    expect(edit.status).toBe(403);
    // the device key that spoke for the call is gone, and the federation hears of it and of the moved find
    expect(await env.DB.prepare("SELECT 1 AS x FROM callsign_keys WHERE callsign LIKE 'OE8APR%'").first()).toBeNull();
    const tomb = await env.DB.prepare("SELECT kind, target_id FROM tombstones ORDER BY kind").all<{
      kind: string;
      target_id: string;
    }>();
    expect(tomb.results.map((t) => t.kind)).toEqual(["find", "key"]);
    expect(tomb.results.every((t) => t.target_id.startsWith("gw.test:"))).toBe(true);
    // the cache is served again to peers, under the marker
    const feed = await call(env, "GET", "/federation/caches?since=0");
    expect(feed.data.items.find((i: { id: string }) => i.id === `gw.test:cache:${cacheId}`).data.ownerCall).toBe(
      "FORMER",
    );
    // the previous holder is told in the app
    const alert = await env.DB.prepare("SELECT kind, detail FROM watch_alerts WHERE account_id = ?")
      .bind(squatAcct)
      .first<{ kind: string; detail: string }>();
    expect(alert).toMatchObject({ kind: "call_released" });
    expect(alert!.detail).toMatch(/OE8APR/);

    // they sign in again by email with the call they operate now, and their content comes with them
    const login = await call(env, "POST", "/auth/email/start", { email: "squat@example.test" });
    expect(login.data.reason).toBe("needs_callsign");
    const back = await emailSignup(env, "squat@example.test", "DL9NEW");
    expect(back.status).toBe(200);
    expect((await session(env, back.cookie)).callsign).toBe("DL9NEW");
    expect(await holderOf(env, "DL9NEW")).toBe(squatAcct);
    const after = await env.DB.prepare("SELECT owner_call FROM caches WHERE id = ?")
      .bind(cacheId)
      .first<{ owner_call: string }>();
    expect(after!.owner_call).toBe("DL9NEW");
  });

  it("shows under the account's remaining call when it holds another", async () => {
    const env = claimEnv();
    const { squatAcct, cacheId } = await squatted(env, { otherCall: "DL1SQU" });
    const opened = await openClaim(env, "OE8APR");
    await proveAmpr(env, "OE8APR", opened.data.claim);
    expect((await status(env, opened.data.claim)).data.status).toBe("done");
    const owner = await env.DB.prepare("SELECT owner_call FROM caches WHERE id = ?")
      .bind(cacheId)
      .first<{ owner_call: string }>();
    expect(owner!.owner_call).toBe("DL1SQU");
    const acct = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id = ?")
      .bind(squatAcct)
      .first<{ callsign: string }>();
    expect(acct!.callsign).toBe("DL1SQU");
    const primary = await env.DB.prepare("SELECT callsign, is_primary FROM account_callsigns WHERE account_id = ?")
      .bind(squatAcct)
      .all();
    expect(primary.results).toEqual([{ callsign: "DL1SQU", is_primary: 1 }]);
    // they still sign in, by email, as DL1SQU
    const back = await call(env, "POST", "/auth/email/start", { email: "squat@example.test" });
    const s = await call(env, "POST", "/auth/email/verify", { token: back.data.devToken });
    expect((await session(env, s.cookie)).callsign).toBe("DL1SQU");
  });
});

describe("federation", () => {
  it("peers drop the previous holder's key and finds on the call, re-mirror their cache, and see the new holder's key verified", async () => {
    const key = await newFedKey();
    const env = claimEnv({ INSTANCE: "a.example", FED_PRIVATE_KEY: key.env });
    const hub = authEnv({ INSTANCE: "hub.example", FED_PRIVATE_KEY: (await newFedKey()).env });
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES ('https://a.example', 'a.example', ?, 'trusted', 'manual')",
    )
      .bind(key.pub)
      .run();
    stubFetch({ "https://a.example": serve(env) });

    const squat = await emailSignup(env, "squat@example.test", "OE8APR");
    const finder = await hiderSignup(env, "owner@example.test", "DL1OWN");
    const theirs = await call(
      env,
      "POST",
      "/api/caches",
      { title: "oak", type: "traditional", lat: 47, lon: 15 },
      {
        cookie: finder.cookie,
      },
    );
    const mine = await call(
      env,
      "POST",
      "/api/caches",
      { title: "elm", type: "traditional", lat: 46, lon: 14, ownerCall: "OE8APR" },
      // an unverified holder hides nothing from the web; the cache came in over the air, owned by the call
      INGEST,
    );
    await call(
      env,
      "POST",
      `/api/caches/${theirs.data.cache.id}/logs`,
      { logType: "note", comment: "hi" },
      {
        cookie: squat.cookie,
      },
    );
    const devKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await call(env, "POST", "/keys/register", { callsign: "OE8APR-7", publicKey: devKey() }, { cookie: squat.cookie });
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    const keys = () =>
      hub.DB.prepare("SELECT callsign, verified FROM remote_keys WHERE callsign LIKE 'OE8APR%'").all<{
        callsign: string;
        verified: number;
      }>();
    expect((await keys()).results).toEqual([{ callsign: "OE8APR-7", verified: 0 }]);
    const finds = () => hub.DB.prepare("SELECT logger_call FROM remote_finds").all<{ logger_call: string }>();
    expect((await finds()).results).toEqual([{ logger_call: "OE8APR" }]);

    const opened = await openClaim(env, "OE8APR");
    await proveLotw(env, opened.data.claim);
    const lic = await status(env, opened.data.claim);
    await call(env, "POST", "/keys/register", { callsign: "OE8APR-9", publicKey: devKey() }, { cookie: lic.cookie });
    expect((await syncAllPeers(hub)).errors).toEqual([]);

    expect((await keys()).results).toEqual([{ callsign: "OE8APR-9", verified: 1 }]);
    expect((await finds()).results).toEqual([]);
    const cache = await hub.DB.prepare("SELECT owner_call FROM remote_caches WHERE global_id = ?")
      .bind(`a.example:cache:${mine.data.cache.id}`)
      .first<{ owner_call: string }>();
    expect(cache!.owner_call).toBe("FORMER");
  });
});

describe("ADMIN_CALLSIGNS", () => {
  it("is registered only through the operator's link or a proof of control", async () => {
    const env = claimEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    expect(
      (await call(env, "POST", "/auth/email/start", { email: "x@example.test", callsign: "OE8APR" })).data.reason,
    ).toBe("operator_call");
    expect((await passkeyRegister(env, "OE8APR-9", await newAuthenticator())).data.reason).toBe("operator_call");
    expect((await call(env, "POST", "/auth/claim", { callsign: "OE8APR" })).data.operatorCall).toBe(true);
    const other = await emailSignup(env, "other@example.test", "DL1AAA");
    expect(
      (await call(env, "POST", "/auth/callsigns", { callsign: "OE8APR" }, { cookie: other.cookie })).data.reason,
    ).toBe("operator_call");
    expect(
      (await call(env, "POST", "/auth/callsign", { callsign: "OE8APR" }, { cookie: other.cookie })).data.reason,
    ).toBe("operator_call");

    // a proof of control registers it, and makes its holder the sysop
    const opened = await openClaim(env, "OE8APR");
    expect(opened.status).toBe(201);
    await proveLotw(env, opened.data.claim);
    const done = await status(env, opened.data.claim);
    expect((await call(env, "GET", "/api/admin/whoami", undefined, { cookie: done.cookie })).data.sysop).toBe(true);
  });

  it("opens to the operator's link on an off-grid instance, and a held operator call cannot be claimed", async () => {
    // off-grid: no https APP_URL, no email — the operator's link is the way in (docs/run/first-hour.md)
    const env = claimEnv({ ADMIN_CALLSIGNS: "OE8APR", APP_URL: "http://192.168.1.20:8080", RP_ID: undefined });
    const op = await operatorSignup(env, "OE8APR");
    expect(op.status).toBe(200);
    expect((await session(env, op.cookie)).callsign).toBe("OE8APR");
    const r = await openClaim(env, "OE8APR");
    expect(r.status).toBe(409);
    expect(r.data.reason).toBe("operator_call");
    await operatorVerify(env, "OE8APR");
    expect((await call(env, "GET", "/api/admin/whoami", undefined, { cookie: op.cookie })).data.sysop).toBe(true);
  });
});

describe("the sysop", () => {
  async function sysopWorld() {
    const env = claimEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const sysop = await operatorSignup(env, "OE8SYS");
    await operatorVerify(env, "OE8SYS");
    const user = await emailSignup(env, "user@example.test", "DL1USR");
    return { env, sysop, user };
  }

  it("looks a call up and releases it from its holder only for the account it saw, with a reason", async () => {
    const { env, sysop, user } = await sysopWorld();
    const userAcct = await accountOf(env, user.cookie);
    expect((await call(env, "GET", "/api/admin/callsigns/DL1USR", undefined, { cookie: user.cookie })).status).toBe(
      403,
    );
    const seen = await call(env, "GET", "/api/admin/callsigns/DL1USR", undefined, { cookie: sysop.cookie });
    expect(seen.data).toMatchObject({
      callsign: "DL1USR",
      adminCall: false,
      verification: null,
      holder: {
        accountId: userAcct,
        activeCallsign: "DL1USR",
        email: true,
        held: [{ callsign: "DL1USR", isPrimary: true }],
      },
    });
    const path = "/api/admin/callsigns/DL1USR";
    expect(
      (await call(env, "POST", path, { action: "release", reason: "x", holder: userAcct }, { cookie: sysop.cookie }))
        .status,
    ).toBe(400);
    const unconfirmed = await call(
      env,
      "POST",
      path,
      { action: "release", reason: "licence belongs to someone else" },
      { cookie: sysop.cookie },
    );
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.data.reason).toBe("confirm_holder");
    expect(await holderOf(env, "DL1USR")).toBe(userAcct);

    const done = await call(
      env,
      "POST",
      path,
      { action: "release", reason: "licence belongs to someone else", holder: userAcct },
      { cookie: sysop.cookie },
    );
    expect(done.status).toBe(200);
    expect(await holderOf(env, "DL1USR")).toBeNull();
    expect(await session(env, user.cookie)).toEqual({
      callsign: null,
      ended: {
        reason: "released",
        callsign: "DL1USR",
        by: "sysop",
        note: "licence belongs to someone else",
        callless: true,
      },
    });
    const after = await call(env, "GET", path, undefined, { cookie: sysop.cookie });
    expect(after.data.holder).toBeNull();
    expect(after.data.events[0]).toMatchObject({
      action: "released",
      fromAccount: userAcct,
      actor: "OE8SYS",
      note: "licence belongs to someone else",
    });
  });

  it("verifies a call by hand only once it confirms the holding account", async () => {
    const { env, sysop, user } = await sysopWorld();
    const body = { callsign: "DL1USR", note: "licence seen on a video call" };
    const r = await call(env, "POST", "/api/admin/verifications", body, { cookie: sysop.cookie });
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ reason: "confirm_holder", holder: { activeCallsign: "DL1USR" } });
    expect((await session(env, user.cookie)).verified).toBe(false);
    const ok = await call(
      env,
      "POST",
      "/api/admin/verifications",
      { ...body, holder: r.data.holder.accountId },
      { cookie: sysop.cookie },
    );
    expect(ok.status).toBe(201);
    expect((await session(env, user.cookie)).verified).toBe(true);
  });
});

describe("the person's data", () => {
  it("export lists the claims and the calls gained or lost; erasure drops them from the trail", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const lic = await emailSignup(env, "lic@example.test", "DL2LIC");
    const opened = await openClaim(env, "OE8APR", lic.cookie);
    await proveOnAir(env, "OE8APR", opened.data.claim);
    const licAcct = await accountOf(env, lic.cookie);

    const exp = await call(env, "POST", "/api/account/DL2LIC/export", {}, { cookie: lic.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.callsignClaims).toEqual([
      expect.objectContaining({ callsign: "OE8APR", status: "done", method: "rf_heard" }),
    ]);
    expect(exp.data.callsignChanges).toEqual([
      expect.objectContaining({ callsign: "OE8APR", action: "claimed", change: "gained" }),
    ]);

    const del = await call(env, "POST", "/api/account/DL2LIC/delete", {}, { cookie: lic.cookie });
    expect(del.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT 1 AS x FROM callsign_claims WHERE account_id = ?").bind(licAcct).first(),
    ).toBeNull();
    const ev = await env.DB.prepare("SELECT to_account FROM callsign_events WHERE callsign='OE8APR'").first<{
      to_account: string | null;
    }>();
    expect(ev!.to_account).toBeNull();
  });

  it("an account left with no call exports and erases its data through an email link that opens nothing else", async () => {
    const env = claimEnv();
    const squat = await emailSignup(env, "squat@example.test", "OE8APR");
    const squatAcct = await accountOf(env, squat.cookie);
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    const lic = await status(env, opened.data.claim);
    expect(lic.data.signedIn).toBe(true);

    // an account that holds a call signs in as usual instead, and an unknown address has nothing to open
    expect(
      (await call(env, "POST", "/auth/email/start", { email: "lic@x.test", purpose: "account-data" })).status,
    ).toBe(404);
    await call(env, "POST", "/auth/email/change", { email: "lic@example.test" }, { cookie: lic.cookie });
    await env.DB.prepare(
      "UPDATE accounts SET email = pending_email, pending_email = NULL WHERE pending_email IS NOT NULL",
    ).run();
    const withCall = await call(env, "POST", "/auth/email/start", {
      email: "lic@example.test",
      purpose: "account-data",
    });
    expect(withCall.status).toBe(409);
    expect(withCall.data.reason).toBe("has_callsign");

    const start = await call(env, "POST", "/auth/email/start", {
      email: "squat@example.test",
      purpose: "account-data",
    });
    expect(start.status).toBe(200);
    expect(start.data.purpose).toBe("account-data");
    const opens = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect(opens.status).toBe(200);
    expect(opens.data).toMatchObject({ callsign: null, accountData: true });
    const cookie = opens.cookie;
    expect(await session(env, cookie)).toEqual({ callsign: null, accountData: true });

    // the session acts for nothing but the data: no call is added, no list served, no move or bundle signed
    expect((await call(env, "GET", "/auth/callsigns", undefined, { cookie })).status).toBe(401);
    expect((await call(env, "POST", "/auth/callsigns", { callsign: "DL9NEW" }, { cookie })).status).toBe(401);
    expect((await call(env, "POST", "/api/account/me/bundle", {}, { cookie })).status).toBe(401);
    expect((await call(env, "POST", "/api/account/OE8APR/export", {}, { cookie })).status).toBe(401);
    // and the licensee's own session never reaches the previous holder's data
    expect((await call(env, "POST", "/api/account/me/export", {}, { cookie: lic.cookie })).status).toBe(401);

    const exp = await call(env, "POST", "/api/account/me/export", {}, { cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.account).toMatchObject({ email: "squat@example.test" });
    expect(exp.data.callsignChanges).toEqual([
      expect.objectContaining({ callsign: "OE8APR", action: "claimed", change: "lost" }),
    ]);

    const del = await call(env, "POST", "/api/account/me/delete", {}, { cookie });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE account_id = ?").bind(squatAcct).first()).toBeNull();
    expect(await holderOf(env, "OE8APR")).not.toBeNull(); // the licensee keeps the call
    expect((await call(env, "POST", "/api/account/me/export", {}, { cookie })).status).toBe(401);
  });

  it("a data link stops working once the account takes a call on again", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    const start = await call(env, "POST", "/auth/email/start", {
      email: "squat@example.test",
      purpose: "account-data",
    });
    const opens = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect((await session(env, opens.cookie)).accountData).toBe(true);
    const back = await emailSignup(env, "squat@example.test", "DL9NEW");
    expect(back.status).toBe(200);
    expect(await session(env, opens.cookie)).toEqual({ callsign: null });
  });
});

describe("a suspended holder", () => {
  const suspend = (env: Env, accountId: string) =>
    env.DB.prepare(
      "INSERT INTO account_suspensions (account_id, reason, category, until, by_call, at) VALUES (?, 'spam', 'spam', NULL, 'OE8SYS', ?)",
    )
      .bind(accountId, now())
      .run();

  it("keeps the call against every claim, its own included, until the sysop releases it", async () => {
    const env = claimEnv({ ADMIN_CALLSIGNS: "OE8SYS" });
    const sysop = await operatorSignup(env, "OE8SYS");
    await operatorVerify(env, "OE8SYS");
    const held = await emailSignup(env, "held@example.test", "OE8APR");
    const heldAcct = await accountOf(env, held.cookie);
    await suspend(env, heldAcct);

    const refused = await openClaim(env, "OE8APR");
    expect(refused.status).toBe(409);
    expect(refused.data.reason).toBe("holder_suspended");
    expect(refused.data.error).toMatch(/ask the sysop/);

    // a claim opened before the suspension cannot complete either
    await env.DB.prepare("DELETE FROM account_suspensions").run();
    const early = await openClaim(env, "OE8APR");
    expect(early.status).toBe(201);
    await suspend(env, heldAcct);
    const s = await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR", claim: early.data.claim });
    expect(s.status).toBe(200);
    await call(
      env,
      "POST",
      "/ingest",
      {
        packets: [
          {
            src: "OE8APR-7",
            dst: "APRS",
            path: ["WIDE1-1", "qAR", "OE8XXX"],
            payload: `:${String(s.data.to).padEnd(9)}:${s.data.text}`,
            kind: "message",
            heardVia: "rf",
            igateCall: "OE8XXX",
            port: "kiss-tnc",
            ts: now(),
          },
        ],
      },
      INGEST,
    );
    expect((await status(env, early.data.claim)).data.status).toBe("refused");
    expect(await holderOf(env, "OE8APR")).toBe(heldAcct);

    const release = await call(
      env,
      "POST",
      "/api/admin/callsigns/OE8APR",
      { action: "release", reason: "licensee asked", holder: heldAcct },
      { cookie: sysop.cookie },
    );
    expect(release.status).toBe(200);
    expect(await holderOf(env, "OE8APR")).toBeNull();
  });

  it("collects no session from a claim while suspended, and collects it once the suspension is lifted", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    const newAcct = (await holderOf(env, "OE8APR"))!;
    await suspend(env, newAcct);
    const first = await status(env, opened.data.claim);
    expect(first.status).toBe(403);
    expect(first.cookie).toBe("");
    await env.DB.prepare("DELETE FROM account_suspensions").run();
    const second = await status(env, opened.data.claim);
    expect(second.data.signedIn).toBe(true);
    expect(second.cookie).not.toBe("");
  });

  it("takes no call on through an email link while its account holds none", async () => {
    const env = claimEnv();
    const squat = await emailSignup(env, "squat@example.test", "OE8APR");
    const squatAcct = await accountOf(env, squat.cookie);
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    await suspend(env, squatAcct);
    const back = await emailSignup(env, "squat@example.test", "DL9NEW");
    expect(back.status).toBe(403);
    expect(await holderOf(env, "DL9NEW")).toBeNull();
    const acct = await env.DB.prepare("SELECT callsign FROM accounts WHERE account_id = ?")
      .bind(squatAcct)
      .first<{ callsign: string }>();
    expect(acct!.callsign).toMatch(/^FORMER#/);
  });
});

describe("what beacons under the call", () => {
  it("goes with a takeover, whichever account lists it", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const club = await emailSignup(env, "club@example.test", "DL1CLB");
    const clubAcct = await accountOf(env, club.cookie);
    const t = now();
    // a station the sysop listed on the call for another member, and its weather key
    await env.DB.prepare(
      "INSERT INTO account_stations (account_id, callsign, roles, created_at, updated_at) VALUES (?, 'OE8APR-13', 'weather', ?, ?)",
    )
      .bind(clubAcct, t, t)
      .run();
    await env.DB.prepare(
      "INSERT INTO wx_keys (key, callsign, account_id, created_at) VALUES ('k-club', 'OE8APR', ?, ?)",
    )
      .bind(clubAcct, t)
      .run();
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    expect((await status(env, opened.data.claim)).data.status).toBe("done");
    expect(
      await env.DB.prepare("SELECT 1 AS x FROM account_stations WHERE callsign LIKE 'OE8APR%'").first(),
    ).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM wx_keys WHERE callsign = 'OE8APR'").first()).toBeNull();
  });

  it("leaves nothing the previous holder queued for APRS-IS to go on the air", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const service = serviceCall(env);
    const t = now();
    const queue = (src: string, payload: string, status = "queued") =>
      env.DB.prepare("INSERT INTO aprs_outbox (ts, src_call, kind, payload, status) VALUES (?, ?, 'message', ?, ?)")
        .bind(t, src, payload, status)
        .run();
    await queue("OE8APR-9", ":DL1ABC   :hello{1");
    await queue(service, ":DL1ABC   :de OE8APR: mailbox note");
    await queue("OE8APR", ":DL1ABC   :already out", "sent");
    await queue("DL1CLB", ":OE8APR   :someone else's");
    const opened = await openClaim(env, "OE8APR");
    await proveOnAir(env, "OE8APR", opened.data.claim);
    expect((await status(env, opened.data.claim)).data.status).toBe("done");
    // the service call's answer to the licensee's VERIFY joins the queue after these four
    const left = await env.DB.prepare("SELECT src_call, status FROM aprs_outbox WHERE id <= 4 ORDER BY id").all();
    expect(left.results).toEqual([
      { src_call: "OE8APR", status: "sent" },
      { src_call: "DL1CLB", status: "queued" },
    ]);
  });
});

describe("the on-air proof of a claim", () => {
  it("is bounded per claim and per client address, so no claimant uses up another's", async () => {
    const env = claimEnv();
    await emailSignup(env, "squat@example.test", "OE8APR");
    const a = await call(env, "POST", "/auth/claims", { callsign: "OE8APR" }, {}, "198.51.100.1");
    const b = await call(env, "POST", "/auth/claims", { callsign: "OE8APR" }, {}, "198.51.100.2");
    const start = (claim: string, ip: string) =>
      call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR", claim }, {}, ip);
    for (let i = 0; i < 5; i++) expect((await start(a.data.claim, "198.51.100.1")).status).toBe(200);
    expect((await start(a.data.claim, "198.51.100.1")).status).toBe(429);
    // another claimant on the same call, from another address, still gets a code
    expect((await start(b.data.claim, "198.51.100.2")).status).toBe(200);
    // one address opening claim after claim runs into its own budget: 20 codes an hour across its claims
    const claims: string[] = [];
    for (let i = 0; i < 5; i++)
      claims.push((await call(env, "POST", "/auth/claims", { callsign: "OE8APR" }, {}, "198.51.100.3")).data.claim);
    for (const c of claims.slice(0, 4))
      for (let i = 0; i < 5; i++) expect((await start(c, "198.51.100.3")).status).toBe(200);
    expect((await start(claims[4]!, "198.51.100.3")).status).toBe(429);
  });
});
