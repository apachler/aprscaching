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
    return { squatAcct: await accountOf(env, cookie), cacheId: mine.data.cache.id as number };
  }

  it("stays on their account under FORMER when they hold no other call, and follows them to a new call", async () => {
    const env = claimEnv({ INSTANCE: "gw.test" });
    const { squatAcct, cacheId } = await squatted(env);
    const opened = await openClaim(env, "OE8APR");
    await proveLotw(env, opened.data.claim);
    const lic = await status(env, opened.data.claim);

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
    expect((await session(env, user.cookie)).callsign).toBeNull();
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
});
